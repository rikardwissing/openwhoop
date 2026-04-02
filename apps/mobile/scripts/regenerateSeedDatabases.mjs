import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DERIVED_DATA_SCHEMA_VERSION = 1;

const GRAVITY_STILL_THRESHOLD = 0.01;
const GRAVITY_WINDOW_MINUTES = 15;
const GRAVITY_STILL_FRACTION = 0.7;
const GRAVITY_MAX_GAP_MINUTES = 20;
const MIN_SLEEP_DURATION_MINUTES = 60;
const MAX_SLEEP_PAUSE_MINUTES = 60;
const ACTIVITY_CHANGE_THRESHOLD_MINUTES = 15;
const STRESS_WINDOW = 120;
const SPO2_WINDOW = 30;
const BASE_SLEEP_NEED_MINUTES = 8 * 60;
const MAX_SLEEP_DEBT_MINUTES = 150;

const PPG_THRESHOLDS = {
  inactiveActive: 7629,
  activeSleep: 15258,
  sleepAwake: 22888,
};

function parseSqliteDateTime(value) {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  return new Date(normalized);
}

function formatSqliteDateTime(date) {
  const year = `${date.getFullYear()}`;
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  const second = `${date.getSeconds()}`.padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function dateKey(date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function minutesBetween(start, end) {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseRrIntervals(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part) && part > 0);
}

function parseSensorData(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toHeartRateRecord(row) {
  const sensorData = parseSensorData(row.sensor_data);

  return {
    id: row.id,
    bpm: row.bpm,
    time: row.time,
    date: parseSqliteDateTime(row.time),
    rr: parseRrIntervals(row.rr_intervals),
    stress: row.stress,
    spo2: row.spo2,
    skinTemp: row.skin_temp,
    sensorData,
    gravity: sensorData?.accel_gravity ?? null,
    ppgGreen: sensorData?.ppg_green ?? null,
  };
}

function rrToRmssd(rr) {
  if (rr.length < 2) {
    return null;
  }

  const diffs = rr.slice(1).map((value, index) => (value - rr[index]) ** 2);
  return Math.sqrt(mean(diffs));
}

function rowsInRange(rows, start, end) {
  return rows.filter((row) => row.date >= start && row.date <= end);
}

function calculateRollingHrv(rr) {
  const cleaned = rr.filter((value) => value > 0);
  const values = [];

  for (let index = 0; index + 300 <= cleaned.length; index += 1) {
    const window = cleaned.slice(index, index + 300);
    const rmssd = rrToRmssd(window);
    if (rmssd !== null) {
      values.push(Math.round(rmssd));
    }
  }

  return values;
}

function calculateSleepDebtMinutes(recentSleepDurationsMinutes) {
  const weights = [0.6, 0.3, 0.1];
  const weightedShortfall = recentSleepDurationsMinutes
    .slice(-weights.length)
    .reverse()
    .map((durationMinutes, index) => Math.max(0, BASE_SLEEP_NEED_MINUTES - durationMinutes) * (weights[index] ?? 0))
    .reduce((sum, value) => sum + value, 0);

  return Math.min(MAX_SLEEP_DEBT_MINUTES, Math.round(weightedShortfall));
}

function calculateSleepNeedMinutes(recentSleepDurationsMinutes) {
  return BASE_SLEEP_NEED_MINUTES + calculateSleepDebtMinutes(recentSleepDurationsMinutes);
}

function napCreditHours(naps) {
  return naps.reduce((sum, nap) => {
    const minutes = minutesBetween(nap.start, nap.end);
    const fullCredit = Math.min(minutes, 90);
    const overflow = Math.max(0, minutes - 90);
    return sum + (fullCredit * 0.7 + overflow * 0.3) / 60;
  }, 0);
}

function buildSleepCycle(period, rows) {
  const windowRows = rowsInRange(rows, period.start, period.end);
  if (windowRows.length === 0) {
    return null;
  }

  const rr = windowRows.flatMap((row) => row.rr);
  const hrvValues = calculateRollingHrv(rr);
  const bpmValues = windowRows.map((row) => row.bpm);
  const sleepId = dateKey(period.end);

  return {
    id: sleepId,
    sleepId,
    start: period.start,
    end: period.end,
    minBpm: Math.min(...bpmValues),
    maxBpm: Math.max(...bpmValues),
    avgBpm: Math.round(mean(bpmValues)),
    minHrv: hrvValues.length > 0 ? Math.min(...hrvValues) : 0,
    maxHrv: hrvValues.length > 0 ? Math.max(...hrvValues) : 0,
    avgHrv: hrvValues.length > 0 ? Math.round(mean(hrvValues)) : 0,
    score: null,
  };
}

function scoreSleepCycles(sleeps, naps) {
  const scored = [];

  for (const sleep of sleeps) {
    const priorEnd = scored.at(-1)?.end ?? new Date(sleep.start.getTime() - 86400000);
    const recentNaps = naps.filter((nap) => nap.activity === 'Nap' && nap.start >= priorEnd && nap.end <= sleep.start);
    const needMinutes = calculateSleepNeedMinutes(
      scored.map((priorSleep) => minutesBetween(priorSleep.start, priorSleep.end)),
    );
    const effectiveSleepMinutes = minutesBetween(sleep.start, sleep.end) + Math.round(napCreditHours(recentNaps) * 60);
    scored.push({
      ...sleep,
      score: clamp((effectiveSleepMinutes / needMinutes) * 100, 0, 100),
    });
  }

  return scored;
}

function filterAndMergePeriods(periods) {
  if (periods.length === 0) {
    return [];
  }

  const merged = [];
  let index = 0;

  while (index < periods.length) {
    const current = periods[index];

    if (current.durationMinutes < ACTIVITY_CHANGE_THRESHOLD_MINUTES) {
      if (index > 0 && index + 1 < periods.length && periods[index - 1].activity === periods[index + 1].activity && merged.length > 0) {
        const previous = merged.pop();
        merged.push({
          activity: previous.activity,
          start: previous.start,
          end: periods[index + 1].end,
          durationMinutes: minutesBetween(previous.start, periods[index + 1].end),
        });
        index += 2;
        continue;
      }

      if (index + 1 < periods.length) {
        periods[index + 1] = {
          activity: periods[index + 1].activity,
          start: current.start,
          end: periods[index + 1].end,
          durationMinutes: minutesBetween(current.start, periods[index + 1].end),
        };
        index += 1;
        continue;
      }

      if (merged.length > 0) {
        const previous = merged.pop();
        merged.push({
          activity: previous.activity,
          start: previous.start,
          end: current.end,
          durationMinutes: minutesBetween(previous.start, current.end),
        });
      }
    } else {
      merged.push(current);
    }

    index += 1;
  }

  return merged;
}

function detectFromGravity(history) {
  if (history.length < 2) {
    return [];
  }

  const deltas = [0];
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1].gravity;
    const current = history[index].gravity;

    if (!previous || !current) {
      deltas.push(Number.MAX_VALUE);
      continue;
    }

    const dx = previous[0] - current[0];
    const dy = previous[1] - current[1];
    const dz = previous[2] - current[2];
    deltas.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }

  const intervals = history
    .slice(1)
    .map((record, index) => (record.date.getTime() - history[index].date.getTime()) / 1000)
    .filter((seconds) => seconds > 0 && seconds < 300)
    .sort((left, right) => left - right);

  const medianInterval = intervals.length === 0 ? 60 : intervals[Math.floor(intervals.length / 2)];
  const windowSize = Math.max(3, Math.floor((GRAVITY_WINDOW_MINUTES * 60) / Math.max(1, medianInterval)));
  const stillFractions = deltas.map((_, index) => {
    const half = Math.floor(windowSize / 2);
    const start = Math.max(0, index - half);
    const end = Math.min(deltas.length, index + half + 1);
    const window = deltas.slice(start, end);
    const still = window.filter((value) => value < GRAVITY_STILL_THRESHOLD).length;
    return still / window.length;
  });

  const classified = stillFractions.map((fraction) => fraction >= GRAVITY_STILL_FRACTION);
  const periods = [];
  let runStart = 0;

  for (let index = 1; index <= history.length; index += 1) {
    const endOfData = index === history.length;
    const classChange = !endOfData && classified[index] !== classified[runStart];
    const gapBreak = !endOfData && minutesBetween(history[index - 1].date, history[index].date) > GRAVITY_MAX_GAP_MINUTES;

    if (endOfData || classChange || gapBreak) {
      periods.push({
        activity: classified[runStart] ? 'sleep' : 'active',
        start: history[runStart].date,
        end: history[index - 1].date,
        durationMinutes: minutesBetween(history[runStart].date, history[index - 1].date),
      });

      if (!endOfData) {
        runStart = index;
      }
    }
  }

  return filterAndMergePeriods(periods);
}

function mergeNearbySleepPeriods(periods) {
  const sorted = [...periods].sort((left, right) => left.start.getTime() - right.start.getTime());
  const merged = [];

  for (const period of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.activity === 'sleep' && minutesBetween(previous.end, period.start) < MAX_SLEEP_PAUSE_MINUTES) {
      previous.end = period.end;
      previous.durationMinutes = minutesBetween(previous.start, previous.end);
      continue;
    }

    merged.push({ ...period });
  }

  return merged;
}

function selectSleepAndNapPeriods(periods) {
  const grouped = new Map();

  for (const period of periods) {
    const key = dateKey(period.end);
    grouped.set(key, [...(grouped.get(key) ?? []), period]);
  }

  const sleeps = [];
  const naps = [];

  for (const group of grouped.values()) {
    const longest = [...group].sort((left, right) => right.durationMinutes - left.durationMinutes)[0];

    for (const period of group) {
      if (period.start.getTime() === longest.start.getTime() && period.end.getTime() === longest.end.getTime()) {
        sleeps.push(period);
      } else {
        naps.push(period);
      }
    }
  }

  sleeps.sort((left, right) => left.start.getTime() - right.start.getTime());
  naps.sort((left, right) => left.start.getTime() - right.start.getTime());
  return { sleeps, naps };
}

function buildActivityRecords(periods, sleeps) {
  return periods
    .filter((period) => period.activity === 'active' && period.durationMinutes >= ACTIVITY_CHANGE_THRESHOLD_MINUTES)
    .filter((period) => !sleeps.some((sleep) => period.start <= sleep.end && period.end >= sleep.start))
    .map((period) => ({
      id: `activity-${period.start.toISOString()}`,
      periodId: dateKey(period.end),
      start: period.start,
      end: period.end,
      activity: 'Activity',
    }));
}

function buildNapActivities(periods) {
  return periods.map((period) => ({
    id: `nap-${period.start.toISOString()}`,
    periodId: dateKey(period.end),
    start: period.start,
    end: period.end,
    activity: 'Nap',
  }));
}

function classifyPpgStage(ppgGreen) {
  if (ppgGreen >= PPG_THRESHOLDS.sleepAwake) {
    return 'awake';
  }

  if (ppgGreen >= PPG_THRESHOLDS.activeSleep) {
    return 'light';
  }

  if (ppgGreen >= PPG_THRESHOLDS.inactiveActive) {
    return 'rem';
  }

  return 'deep';
}

function buildStageSegments(sleep, rows) {
  const windowRows = rowsInRange(rows, sleep.start, sleep.end).filter((row) => row.ppgGreen !== null);
  if (windowRows.length === 0) {
    return [];
  }

  const segments = [];
  let currentStage = classifyPpgStage(windowRows[0].ppgGreen ?? 0);
  let start = windowRows[0].date;
  let previous = windowRows[0].date;

  for (let index = 1; index < windowRows.length; index += 1) {
    const row = windowRows[index];
    const stage = classifyPpgStage(row.ppgGreen ?? 0);
    const gapMinutes = minutesBetween(previous, row.date);

    if (stage !== currentStage || gapMinutes > 5) {
      segments.push({
        sleepId: sleep.sleepId,
        start,
        end: previous,
        stage: currentStage,
        isEstimated: true,
      });
      currentStage = stage;
      start = row.date;
    }

    previous = row.date;
  }

  segments.push({
    sleepId: sleep.sleepId,
    start,
    end: previous,
    stage: currentStage,
    isEstimated: true,
  });

  return segments;
}

function calculateStressScore(window) {
  if (window.length < STRESS_WINDOW) {
    return null;
  }

  const realRr = window.flatMap((row) => row.rr);
  const rr = (realRr.length >= STRESS_WINDOW ? realRr : window.map((row) => Math.round((60 / row.bpm) * 1000)))
    .filter((value) => value > 0);

  if (rr.length < STRESS_WINDOW) {
    return null;
  }

  const min = Math.min(...rr);
  const max = Math.max(...rr);
  const bins = new Map();

  for (const value of rr) {
    const bin = Math.floor(value / 50);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }

  const top = [...bins.entries()].sort((left, right) => right[1] - left[1])[0] ?? [0, 0];
  const mode = top[0] * 50 + 25;
  const modeFreq = top[1];
  const variabilityRange = (max - min) / 1000;
  if (variabilityRange < 0.0001) {
    return 10;
  }

  const aMode = modeFreq / rr.length * 100;
  return Math.min(10, Math.round((aMode / (2 * variabilityRange * mode / 1000)) * 100) / 100);
}

function calculateSpo2Score(window) {
  if (window.length < SPO2_WINDOW) {
    return null;
  }

  const valid = window
    .map((row) => ({
      red: row.sensorData?.spo2_red ?? 0,
      ir: row.sensorData?.spo2_ir ?? 0,
    }))
    .filter((row) => row.red > 0 && row.ir > 0);

  if (valid.length < SPO2_WINDOW) {
    return null;
  }

  const meanRed = mean(valid.map((row) => row.red));
  const meanIr = mean(valid.map((row) => row.ir));
  if (meanRed < 1 || meanIr < 1) {
    return null;
  }

  const acRed = Math.sqrt(mean(valid.map((row) => (row.red - meanRed) ** 2)));
  const acIr = Math.sqrt(mean(valid.map((row) => (row.ir - meanIr) ** 2)));
  if (acRed < 0.001 || acIr < 0.001) {
    return null;
  }

  const ratio = (acRed / meanRed) / (acIr / meanIr);
  return clamp(110 - 25 * ratio, 70, 100);
}

function calculateSkinTempValue(row) {
  const raw = row.sensorData?.skin_temp_raw ?? 0;
  if (raw < 100) {
    return null;
  }

  return raw * 0.04;
}

function resetDerivedSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_state (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT,
      last_seen_at TEXT,
      last_synced_at TEXT,
      firmware TEXT,
      battery_percent INTEGER,
      charging_status TEXT,
      body_status TEXT,
      sync_error TEXT
    );

    CREATE TABLE IF NOT EXISTS sleep_preferences (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      target_wake_minutes INTEGER NOT NULL,
      alarm_enabled INTEGER NOT NULL DEFAULT 0,
      alarm_minutes INTEGER,
      updated_at TEXT NOT NULL
    );

    DROP TABLE IF EXISTS activities;
    DROP TABLE IF EXISTS sleep_stage_segments;
    DROP TABLE IF EXISTS derived_data_state;
    DROP TABLE IF EXISTS sleep_cycles;

    CREATE TABLE sleep_cycles (
      id TEXT PRIMARY KEY NOT NULL,
      sleep_id TEXT NOT NULL UNIQUE,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      min_bpm INTEGER NOT NULL,
      max_bpm INTEGER NOT NULL,
      avg_bpm INTEGER NOT NULL,
      min_hrv INTEGER NOT NULL,
      max_hrv INTEGER NOT NULL,
      avg_hrv INTEGER NOT NULL,
      score REAL,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sleep_cycles_start ON sleep_cycles(start);
    CREATE INDEX IF NOT EXISTS idx_sleep_cycles_end ON sleep_cycles(end);

    CREATE TABLE activities (
      id INTEGER PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL,
      start TEXT NOT NULL UNIQUE,
      end TEXT NOT NULL,
      activity TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_activities_start ON activities(start);
    CREATE INDEX IF NOT EXISTS idx_activities_end ON activities(end);

    CREATE TABLE sleep_stage_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      sleep_id TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      stage TEXT NOT NULL,
      is_estimated INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_sleep_stage_segments_sleep_id ON sleep_stage_segments(sleep_id);

    CREATE TABLE derived_data_state (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      derived_schema_version INTEGER NOT NULL,
      source_heart_count INTEGER NOT NULL,
      refreshed_at TEXT NOT NULL
    );
  `);
}

function regenerateDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  resetDerivedSchema(db);

  const heartRows = db
    .prepare('SELECT id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data FROM heart_rate ORDER BY time ASC')
    .all()
    .map(toHeartRateRecord);

  const stressByTime = new Map();
  const spo2ByTime = new Map();
  const tempByTime = new Map();

  for (let index = 0; index < heartRows.length; index += 1) {
    const stressWindow = heartRows.slice(Math.max(0, index - STRESS_WINDOW + 1), index + 1);
    stressByTime.set(heartRows[index].time, calculateStressScore(stressWindow));

    const spo2Window = heartRows.slice(Math.max(0, index - SPO2_WINDOW + 1), index + 1);
    spo2ByTime.set(heartRows[index].time, calculateSpo2Score(spo2Window));

    tempByTime.set(heartRows[index].time, calculateSkinTempValue(heartRows[index]));
  }

  const periods = detectFromGravity(heartRows);
  const sleepCandidates = mergeNearbySleepPeriods(
    periods.filter((period) => period.activity === 'sleep' && period.durationMinutes >= MIN_SLEEP_DURATION_MINUTES),
  );
  const activeCandidates = periods.filter((period) => period.activity === 'active');
  const { sleeps: primarySleepPeriods, naps: napPeriods } = selectSleepAndNapPeriods(sleepCandidates);
  const sleepCycles = scoreSleepCycles(
    primarySleepPeriods
      .map((period) => buildSleepCycle(period, heartRows))
      .filter(Boolean),
    buildNapActivities(napPeriods),
  );
  const activities = [...buildNapActivities(napPeriods), ...buildActivityRecords(activeCandidates, sleepCycles)];
  const stages = sleepCycles.flatMap((sleep) => buildStageSegments(sleep, heartRows));
  const refreshedAt = formatSqliteDateTime(new Date());

  db.exec('BEGIN IMMEDIATE');

  try {
    const updateHeart = db.prepare('UPDATE heart_rate SET stress = ?, spo2 = ?, skin_temp = ? WHERE time = ?');
    for (const row of heartRows) {
      updateHeart.run(
        stressByTime.get(row.time) ?? null,
        spo2ByTime.get(row.time) ?? null,
        tempByTime.get(row.time) ?? null,
        row.time,
      );
    }

    const insertSleep = db.prepare(`
      INSERT INTO sleep_cycles (id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, score, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    for (const sleep of sleepCycles) {
      insertSleep.run(
        sleep.id,
        sleep.sleepId,
        formatSqliteDateTime(sleep.start),
        formatSqliteDateTime(sleep.end),
        sleep.minBpm,
        sleep.maxBpm,
        sleep.avgBpm,
        sleep.minHrv,
        sleep.maxHrv,
        sleep.avgHrv,
        sleep.score,
      );
    }

    const insertActivity = db.prepare(`
      INSERT INTO activities (period_id, start, end, activity, synced)
      VALUES (?, ?, ?, ?, 0)
    `);
    for (const activity of activities) {
      insertActivity.run(
        activity.periodId,
        formatSqliteDateTime(activity.start),
        formatSqliteDateTime(activity.end),
        activity.activity,
      );
    }

    const insertStage = db.prepare(`
      INSERT INTO sleep_stage_segments (sleep_id, start, end, stage, is_estimated)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const stage of stages) {
      insertStage.run(
        stage.sleepId,
        formatSqliteDateTime(stage.start),
        formatSqliteDateTime(stage.end),
        stage.stage,
        stage.isEstimated ? 1 : 0,
      );
    }

    db.prepare(`
      INSERT INTO derived_data_state (id, derived_schema_version, source_heart_count, refreshed_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        derived_schema_version = excluded.derived_schema_version,
        source_heart_count = excluded.source_heart_count,
        refreshed_at = excluded.refreshed_at
    `).run(
      DERIVED_DATA_SCHEMA_VERSION,
      heartRows.length,
      refreshedAt,
    );

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }

  const counts = {
    heart: db.prepare('SELECT COUNT(*) AS count FROM heart_rate').get().count,
    sleep: db.prepare('SELECT COUNT(*) AS count FROM sleep_cycles').get().count,
    activities: db.prepare('SELECT COUNT(*) AS count FROM activities').get().count,
    stages: db.prepare('SELECT COUNT(*) AS count FROM sleep_stage_segments').get().count,
  };

  db.close();
  return counts;
}

const databaseFiles = [
  path.join(projectRoot, 'assets', 'databases', 'btwearable-seed.db'),
  path.join(projectRoot, 'assets', 'databases', 'db.sqlite'),
];

for (const filePath of databaseFiles) {
  const counts = regenerateDatabase(filePath);
  console.log(`${path.basename(filePath)} regenerated`, counts);
}
