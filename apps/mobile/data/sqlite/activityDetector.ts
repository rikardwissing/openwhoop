import { minutesBetween } from '@/utils/dateTime';
import { clamp, mean, median } from '@/utils/math';

const GRAVITY_STILL_THRESHOLD = 0.01;
const GRAVITY_WINDOW_MINUTES = 15;
const GRAVITY_STILL_FRACTION = 0.7;
const GRAVITY_MAX_GAP_MINUTES = 20;
const MIN_SLEEP_DURATION_MINUTES = 60;
const MIN_SLEEP_CANDIDATE_DURATION_MINUTES = 5;
const ACTIVITY_CHANGE_THRESHOLD_MINUTES = 15;

const EPOCH_30S_MS = 30_000;
const EPOCH_60S_MS = 60_000;
const EPOCH_120S_MS = 120_000;
const EPOCH_300S_MS = 300_000;

const SLEEP_STILLNESS_BUCKET_MS = 30_000;

const MIN_ACTIVITY_DURATION_MINUTES = 10;
const MAX_ACTIVITY_REST_BRIDGE_MINUTES = 5;
const ACTIVE_MOTION_FLOOR = 0.006;
const ACTIVE_STRONG_MOTION_FLOOR = 0.015;
const ACTIVE_POSTURE_SHIFT_FLOOR = 0.12;
const ACTIVE_HEART_RATE_FLOOR = 88;
const ACTIVE_HEART_RATE_DELTA = 15;
const WALK_HEART_RATE_FLOOR = 74;
const WORKOUT_HEART_RATE_FLOOR = 104;
const MIN_CONTACT_RATIO = 0.5;
const MIN_SIGNAL_RATIO = 0.5;

export type ActivityDetectorKind = 'sleep' | 'activity' | 'walk' | 'workout';

export interface ActivityDetectorInputRow {
  date: Date;
  bpm: number;
  rr: readonly number[];
  gravity: [number, number, number] | null;
  skinContact: number | null;
  signalQuality: number | null;
  ppgGreen: number | null;
}

export interface ActivityDetectorPeriod {
  start: Date;
  end: Date;
  durationMinutes: number;
  confidence: number;
  kind: ActivityDetectorKind;
}

export interface ActivityDetectionArtifacts {
  sleepCandidates: ActivityDetectorPeriod[];
  activityCandidates: ActivityDetectorPeriod[];
}

type BinaryPeriodKind = 'sleep' | 'wake';
type ActivityEpochState = 'activity' | 'rest' | 'off_body';

interface BinaryPeriod {
  kind: BinaryPeriodKind;
  start: Date;
  end: Date;
  durationMinutes: number;
}

interface StillnessRow {
  date: Date;
  gravity: [number, number, number] | null;
  skinContact: number | null;
}

interface ActivityEpoch {
  start: Date;
  end: Date;
  avgBpm: number;
  motionScore: number;
  postureCentroid: [number, number, number] | null;
  postureShift: number;
  contactRatio: number;
  signalQualityRatio: number;
  hasContactData: boolean;
  hasSignalQualityData: boolean;
  state: ActivityEpochState;
  confidence: number;
}

interface ActivityContext {
  bpmQ50: number;
  bpmQ75: number;
  bpmQ90: number;
  motionQ75: number;
  motionQ90: number;
}

function quantile(values: number[], percentile: number) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = clamp(percentile, 0, 1) * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }

  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

function gravityDelta(left: [number, number, number] | null, right: [number, number, number] | null) {
  if (!left || !right) {
    return Number.MAX_VALUE;
  }

  const dx = left[0] - right[0];
  const dy = left[1] - right[1];
  const dz = left[2] - right[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function postureShiftDelta(left: [number, number, number] | null, right: [number, number, number] | null) {
  if (!left || !right) {
    return 0;
  }

  return gravityDelta(left, right);
}

function aggregateStillnessRows(history: readonly ActivityDetectorInputRow[], bucketMs: number) {
  if (history.length === 0) {
    return [] as StillnessRow[];
  }

  const originMs = history[0].date.getTime();
  const buckets = new Map<number, ActivityDetectorInputRow[]>();

  for (const row of history) {
    const bucketIndex = Math.floor((row.date.getTime() - originMs) / bucketMs);
    const bucket = buckets.get(bucketIndex) ?? [];
    bucket.push(row);
    buckets.set(bucketIndex, bucket);
  }

  return [...buckets.keys()]
    .sort((left, right) => left - right)
    .map((bucketIndex) => {
      const rows = buckets.get(bucketIndex)!;
      const gravityRows = rows.filter((row) => row.gravity !== null);
      const gravity = gravityRows.length === 0
        ? null
        : [
            mean(gravityRows.map((row) => row.gravity![0])),
            mean(gravityRows.map((row) => row.gravity![1])),
            mean(gravityRows.map((row) => row.gravity![2])),
          ] as [number, number, number];
      const contactValues = rows
        .map((row) => row.skinContact)
        .filter((value): value is number => value !== null);

      return {
        date: rows[Math.floor(rows.length / 2)]?.date ?? rows[0].date,
        gravity,
        skinContact:
          contactValues.length === 0
            ? null
            : contactValues.filter((value) => value > 0).length / contactValues.length >= 0.5
              ? 1
              : 0,
      } satisfies StillnessRow;
    });
}

function filterAndMergeBinaryPeriods(periods: BinaryPeriod[]): BinaryPeriod[] {
  if (periods.length === 0) {
    return [];
  }

  const merged: BinaryPeriod[] = [];
  let index = 0;

  while (index < periods.length) {
    const current = periods[index];

    if (current.durationMinutes < ACTIVITY_CHANGE_THRESHOLD_MINUTES) {
      if (
        index > 0 &&
        index + 1 < periods.length &&
        periods[index - 1].kind === periods[index + 1].kind &&
        merged.length > 0
      ) {
        const previous = merged.pop()!;
        merged.push({
          kind: previous.kind,
          start: previous.start,
          end: periods[index + 1].end,
          durationMinutes: minutesBetween(previous.start, periods[index + 1].end),
        });
        index += 2;
        continue;
      }

      if (index + 1 < periods.length) {
        periods[index + 1] = {
          kind: periods[index + 1].kind,
          start: current.start,
          end: periods[index + 1].end,
          durationMinutes: minutesBetween(current.start, periods[index + 1].end),
        };
        index += 1;
        continue;
      }

      if (merged.length > 0) {
        const previous = merged.pop()!;
        merged.push({
          kind: previous.kind,
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

function detectStillnessPeriods(history: readonly ActivityDetectorInputRow[]) {
  if (history.length < 2) {
    return [] as BinaryPeriod[];
  }

  const intervals = history
    .slice(1)
    .map((record, index) => (record.date.getTime() - history[index].date.getTime()) / 1000)
    .filter((seconds) => seconds > 0 && seconds < 300)
    .sort((left, right) => left - right);

  const sourceMedianInterval = intervals.length === 0 ? 60 : intervals[Math.floor(intervals.length / 2)];
  const stillnessRows = sourceMedianInterval <= 5
    ? aggregateStillnessRows(history, SLEEP_STILLNESS_BUCKET_MS)
    : history.map((row) => ({
        date: row.date,
        gravity: row.gravity,
        skinContact: row.skinContact,
      }));

  if (stillnessRows.length < 2) {
    return [] as BinaryPeriod[];
  }

  const deltas: number[] = [0];
  for (let index = 1; index < stillnessRows.length; index += 1) {
    deltas.push(gravityDelta(stillnessRows[index - 1].gravity, stillnessRows[index].gravity));
  }

  const stillnessIntervals = stillnessRows
    .slice(1)
    .map((record, index) => (record.date.getTime() - stillnessRows[index].date.getTime()) / 1000)
    .filter((seconds) => seconds > 0 && seconds < 300)
    .sort((left, right) => left - right);
  const stillnessMedianInterval = stillnessIntervals.length === 0
    ? Math.max(sourceMedianInterval, SLEEP_STILLNESS_BUCKET_MS / 1000)
    : stillnessIntervals[Math.floor(stillnessIntervals.length / 2)];
  const windowSize = Math.max(3, Math.floor((GRAVITY_WINDOW_MINUTES * 60) / Math.max(1, stillnessMedianInterval)));
  const halfWindow = Math.floor(windowSize / 2);
  const stillPrefixCounts = new Array<number>(deltas.length + 1).fill(0);

  for (let index = 0; index < deltas.length; index += 1) {
    stillPrefixCounts[index + 1] = stillPrefixCounts[index] + (deltas[index] < GRAVITY_STILL_THRESHOLD ? 1 : 0);
  }

  const classified = stillnessRows.map((row, index) => {
    const start = Math.max(0, index - halfWindow);
    const end = Math.min(deltas.length, index + halfWindow + 1);
    const stillCount = stillPrefixCounts[end] - stillPrefixCounts[start];
    return stillCount / Math.max(1, end - start) >= GRAVITY_STILL_FRACTION && row.skinContact !== 0;
  });

  const periods: BinaryPeriod[] = [];
  let runStart = 0;

  for (let index = 1; index <= stillnessRows.length; index += 1) {
    const endOfData = index === stillnessRows.length;
    const classChange = !endOfData && classified[index] !== classified[runStart];
    const gapBreak =
      !endOfData && minutesBetween(stillnessRows[index - 1].date, stillnessRows[index].date) > GRAVITY_MAX_GAP_MINUTES;

    if (endOfData || classChange || gapBreak) {
      periods.push({
        kind: classified[runStart] ? 'sleep' : 'wake',
        start: stillnessRows[runStart].date,
        end: stillnessRows[index - 1].date,
        durationMinutes: minutesBetween(stillnessRows[runStart].date, stillnessRows[index - 1].date),
      });

      if (!endOfData) {
        runStart = index;
      }
    }
  }

  return filterAndMergeBinaryPeriods(periods);
}

function mergeAdjacentPeriods(periods: readonly ActivityDetectorPeriod[]) {
  if (periods.length === 0) {
    return [] as ActivityDetectorPeriod[];
  }

  const merged: ActivityDetectorPeriod[] = [];

  for (const period of periods) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...period });
      continue;
    }

    const gapMinutes = minutesBetween(previous.end, period.start);
    if (gapMinutes > MAX_ACTIVITY_REST_BRIDGE_MINUTES || previous.kind !== period.kind) {
      merged.push({ ...period });
      continue;
    }

    const previousDuration = Math.max(0, previous.durationMinutes);
    const nextDuration = Math.max(0, period.durationMinutes);
    const combinedDuration = previousDuration + gapMinutes + nextDuration;
    previous.end = period.end;
    previous.durationMinutes = minutesBetween(previous.start, period.end);
    previous.confidence = combinedDuration <= 0
      ? Math.min(previous.confidence, period.confidence)
      : ((previous.confidence * previousDuration) + (period.confidence * nextDuration)) /
        Math.max(previousDuration + nextDuration, 1);
  }

  return merged;
}

function resolveEpochDurationMs(rows: readonly ActivityDetectorInputRow[]) {
  const gaps: number[] = [];

  for (let index = 1; index < rows.length; index += 1) {
    const gapMs = rows[index].date.getTime() - rows[index - 1].date.getTime();
    if (gapMs > 0) {
      gaps.push(gapMs);
    }
  }

  const medianGapMs = median(gaps) ?? EPOCH_60S_MS;
  if (medianGapMs <= 2_000) {
    return EPOCH_30S_MS;
  }
  if (medianGapMs <= 10_000) {
    return EPOCH_60S_MS;
  }
  if (medianGapMs <= 30_000) {
    return EPOCH_120S_MS;
  }

  return EPOCH_300S_MS;
}

function fallsWithinPeriods(date: Date, periods: readonly ActivityDetectorPeriod[]) {
  const timestamp = date.getTime();
  return periods.some((period) => timestamp >= period.start.getTime() && timestamp <= period.end.getTime());
}

function buildActivityEpochs(
  rows: readonly ActivityDetectorInputRow[],
  sleepCandidates: readonly ActivityDetectorPeriod[],
) {
  const wakeRows = rows
    .filter((row) => !fallsWithinPeriods(row.date, sleepCandidates))
    .sort((left, right) => left.date.getTime() - right.date.getTime());

  if (wakeRows.length === 0) {
    return {
      epochDurationMs: EPOCH_60S_MS,
      epochs: [] as ActivityEpoch[],
    };
  }

  const epochDurationMs = resolveEpochDurationMs(wakeRows);
  const originMs = wakeRows[0].date.getTime();
  const buckets = new Map<number, ActivityDetectorInputRow[]>();

  for (const row of wakeRows) {
    const bucketIndex = Math.floor((row.date.getTime() - originMs) / epochDurationMs);
    const bucket = buckets.get(bucketIndex) ?? [];
    bucket.push(row);
    buckets.set(bucketIndex, bucket);
  }

  const bucketIndexes = [...buckets.keys()].sort((left, right) => left - right);
  const epochs = bucketIndexes.map((bucketIndex) => {
    const bucketRows = buckets.get(bucketIndex)!;
    const gravityRows = bucketRows.filter((row) => row.gravity !== null);
    const postureCentroid = gravityRows.length === 0
      ? null
      : [
          mean(gravityRows.map((row) => row.gravity![0])),
          mean(gravityRows.map((row) => row.gravity![1])),
          mean(gravityRows.map((row) => row.gravity![2])),
        ] as [number, number, number];
    const motionValues: number[] = [];

    for (let index = 1; index < bucketRows.length; index += 1) {
      const delta = gravityDelta(bucketRows[index - 1].gravity, bucketRows[index].gravity);
      if (Number.isFinite(delta) && delta !== Number.MAX_VALUE) {
        motionValues.push(delta);
      }
    }

    const contactValues = bucketRows.filter((row) => row.skinContact !== null).map((row) => row.skinContact!);
    const signalValues = bucketRows.filter((row) => row.signalQuality !== null).map((row) => row.signalQuality!);

    return {
      start: bucketRows[0].date,
      end: bucketRows[bucketRows.length - 1].date,
      avgBpm: mean(bucketRows.map((row) => row.bpm)),
      motionScore: motionValues.length === 0 ? 0 : mean(motionValues),
      postureCentroid,
      postureShift: 0,
      contactRatio:
        contactValues.length === 0 ? 1 : contactValues.filter((value) => value > 0).length / contactValues.length,
      signalQualityRatio:
        signalValues.length === 0 ? 1 : signalValues.filter((value) => value > 0).length / signalValues.length,
      hasContactData: contactValues.length > 0,
      hasSignalQualityData: signalValues.length > 0,
      state: 'rest' as const,
      confidence: 0,
    } satisfies ActivityEpoch;
  });

  for (let index = 0; index < epochs.length; index += 1) {
    epochs[index].postureShift = postureShiftDelta(
      epochs[index - 1]?.postureCentroid ?? null,
      epochs[index].postureCentroid,
    );
  }

  return {
    epochDurationMs,
    epochs,
  };
}

function buildActivityContext(epochs: readonly ActivityEpoch[]): ActivityContext {
  const bpmValues = epochs.map((epoch) => epoch.avgBpm).filter((value) => Number.isFinite(value));
  const motionValues = epochs.map((epoch) => epoch.motionScore).filter((value) => Number.isFinite(value));
  const bpmMedian = median(bpmValues) ?? 0;
  const motionMedian = median(motionValues) ?? 0;

  return {
    bpmQ50: bpmMedian,
    bpmQ75: quantile(bpmValues, 0.75) ?? bpmMedian,
    bpmQ90: quantile(bpmValues, 0.9) ?? bpmMedian,
    motionQ75: quantile(motionValues, 0.75) ?? motionMedian,
    motionQ90: quantile(motionValues, 0.9) ?? motionMedian,
  };
}

function classifyActivityEpochs(epochs: ActivityEpoch[], context: ActivityContext) {
  let previousState: ActivityEpochState = 'rest';

  for (const epoch of epochs) {
    if (epoch.hasContactData && epoch.contactRatio < MIN_CONTACT_RATIO) {
      epoch.state = 'off_body';
      epoch.confidence = 1;
      previousState = epoch.state;
      continue;
    }

    const lowSignal = epoch.hasSignalQualityData && epoch.signalQualityRatio < MIN_SIGNAL_RATIO;
    const hasQualitySignals = epoch.hasContactData || epoch.hasSignalQualityData;
    const strongMotion = epoch.motionScore >= Math.max(context.motionQ90, ACTIVE_STRONG_MOTION_FLOOR);
    const mediumMotion = epoch.motionScore >= Math.max(context.motionQ75, ACTIVE_MOTION_FLOOR);
    const postureChange = epoch.postureShift >= ACTIVE_POSTURE_SHIFT_FLOOR;
    const elevatedHeartRate = epoch.avgBpm >= Math.max(context.bpmQ90, ACTIVE_HEART_RATE_FLOOR);
    const aboveBaselineHeartRate = epoch.avgBpm >= Math.max(context.bpmQ75 + 8, context.bpmQ50 + ACTIVE_HEART_RATE_DELTA, 78);
    const gravityMotionSupported =
      hasQualitySignals &&
      postureChange &&
      aboveBaselineHeartRate &&
      (strongMotion || (mediumMotion && elevatedHeartRate));
    const motionDriven: boolean =
      gravityMotionSupported &&
      (postureChange || previousState === 'activity' || epoch.avgBpm >= Math.max(context.bpmQ50 + 6, 72));
    const heartDriven: boolean =
      elevatedHeartRate && ((hasQualitySignals && mediumMotion && postureChange) || previousState === 'activity');
    const sustainedActivity: boolean =
      previousState === 'activity' &&
      aboveBaselineHeartRate &&
      hasQualitySignals &&
      mediumMotion &&
      postureChange;
    const isActivity: boolean = motionDriven || heartDriven || sustainedActivity;
    const evidenceCount = [strongMotion || mediumMotion, postureChange, elevatedHeartRate || aboveBaselineHeartRate]
      .filter(Boolean)
      .length;

    epoch.state = isActivity ? 'activity' : 'rest';
    epoch.confidence = clamp((evidenceCount - (lowSignal ? 0.5 : 0)) / 3, 0.1, 1);
    previousState = epoch.state;
  }

  return epochs;
}

function classifyActivityKind(period: ActivityDetectorPeriod, epochs: readonly ActivityEpoch[], context: ActivityContext): ActivityDetectorKind {
  const overlapping = epochs.filter((epoch) => epoch.end >= period.start && epoch.start <= period.end);
  if (overlapping.length === 0) {
    return 'activity';
  }

  const avgBpm = mean(overlapping.map((epoch) => epoch.avgBpm));
  const avgMotion = mean(overlapping.map((epoch) => epoch.motionScore));
  const maxMotion = Math.max(...overlapping.map((epoch) => epoch.motionScore));

  const workoutHeart = avgBpm >= Math.max(context.bpmQ90 + 6, WORKOUT_HEART_RATE_FLOOR);
  const workoutMotion = maxMotion >= Math.max(context.motionQ90 * 1.1, ACTIVE_STRONG_MOTION_FLOOR * 1.5);
  if (workoutHeart && (workoutMotion || period.durationMinutes >= 20)) {
    return 'workout';
  }

  const walkHeart = avgBpm >= Math.max(context.bpmQ50 + 4, WALK_HEART_RATE_FLOOR);
  const walkMotion = avgMotion >= Math.max(context.motionQ75, ACTIVE_MOTION_FLOOR);
  if (walkHeart && walkMotion) {
    return 'walk';
  }

  return 'activity';
}

function collectActivityCandidates(epochs: readonly ActivityEpoch[], context: ActivityContext) {
  if (epochs.length === 0) {
    return [] as ActivityDetectorPeriod[];
  }

  const periods: Array<Omit<ActivityDetectorPeriod, 'kind'> & { state: ActivityEpochState }> = [];
  let state = epochs[0].state;
  let start = epochs[0].start;
  let end = epochs[0].end;
  let confidenceTotal = epochs[0].confidence;
  let confidenceCount = 1;

  for (let index = 1; index < epochs.length; index += 1) {
    const epoch = epochs[index];
    const gapMinutes = minutesBetween(end, epoch.start);

    if (epoch.state !== state || gapMinutes > GRAVITY_MAX_GAP_MINUTES) {
      periods.push({
        state,
        start,
        end,
        durationMinutes: minutesBetween(start, end),
        confidence: confidenceTotal / Math.max(confidenceCount, 1),
      });
      state = epoch.state;
      start = epoch.start;
      end = epoch.end;
      confidenceTotal = epoch.confidence;
      confidenceCount = 1;
      continue;
    }

    end = epoch.end;
    confidenceTotal += epoch.confidence;
    confidenceCount += 1;
  }

  periods.push({
    state,
    start,
    end,
    durationMinutes: minutesBetween(start, end),
    confidence: confidenceTotal / Math.max(confidenceCount, 1),
  });

  const bridged: ActivityDetectorPeriod[] = [];

  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index];
    const previous = periods[index - 1];
    const next = periods[index + 1];

    if (
      period.state === 'rest' &&
      period.durationMinutes <= MAX_ACTIVITY_REST_BRIDGE_MINUTES &&
      previous?.state === 'activity' &&
      next?.state === 'activity'
    ) {
      bridged.push({
        start: period.start,
        end: period.end,
        durationMinutes: period.durationMinutes,
        confidence: Math.min(period.confidence, 0.4),
        kind: 'activity',
      });
      continue;
    }

    if (period.state !== 'activity') {
      continue;
    }

    bridged.push({
      start: period.start,
      end: period.end,
      durationMinutes: period.durationMinutes,
      confidence: period.confidence,
      kind: 'activity',
    });
  }

  return mergeAdjacentPeriods(bridged)
    .filter((period) => period.durationMinutes >= MIN_ACTIVITY_DURATION_MINUTES)
    .map((period) => ({
      ...period,
      kind: classifyActivityKind(period, epochs, context),
    }));
}

export function detectActivityArtifacts(rows: readonly ActivityDetectorInputRow[]): ActivityDetectionArtifacts {
  const periods = detectStillnessPeriods(rows);
  const sleepCandidates = periods
    .filter((period) => period.kind === 'sleep' && period.durationMinutes >= MIN_SLEEP_CANDIDATE_DURATION_MINUTES)
    .map((period) => ({
      start: period.start,
      end: period.end,
      durationMinutes: period.durationMinutes,
      confidence: 1,
      kind: 'sleep' as const,
    }));
  const { epochs } = buildActivityEpochs(rows, sleepCandidates);

  if (epochs.length === 0) {
    return {
      sleepCandidates,
      activityCandidates: [],
    };
  }

  const context = buildActivityContext(epochs);
  const activityCandidates = collectActivityCandidates(classifyActivityEpochs(epochs, context), context);

  return {
    sleepCandidates,
    activityCandidates,
  };
}