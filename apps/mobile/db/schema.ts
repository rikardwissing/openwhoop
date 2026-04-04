import type { SQLiteDatabase } from 'expo-sqlite';

export const APP_DATABASE_NAME = 'btwearable.db';
export const DERIVED_DATA_SCHEMA_VERSION = 4;

export async function initializeDatabase(db: SQLiteDatabase) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS heart_rate (
      id INTEGER PRIMARY KEY NOT NULL,
      bpm INTEGER NOT NULL,
      time TEXT NOT NULL UNIQUE,
      rr_intervals TEXT NOT NULL,
      activity INTEGER,
      stress REAL,
      imu_data TEXT,
      synced INTEGER NOT NULL DEFAULT 0,
      sensor_data TEXT,
      spo2 REAL,
      skin_temp REAL
    );

    CREATE INDEX IF NOT EXISTS idx_heart_rate_time ON heart_rate(time);

    CREATE TABLE IF NOT EXISTS sleep_cycles (
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
      avg_skin_temp REAL,
      score REAL,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sleep_cycles_start ON sleep_cycles(start);
    CREATE INDEX IF NOT EXISTS idx_sleep_cycles_end ON sleep_cycles(end);

    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL,
      start TEXT NOT NULL UNIQUE,
      end TEXT NOT NULL,
      activity TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_activities_start ON activities(start);
    CREATE INDEX IF NOT EXISTS idx_activities_end ON activities(end);

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

    CREATE TABLE IF NOT EXISTS derived_data_state (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      derived_schema_version INTEGER NOT NULL,
      source_heart_count INTEGER NOT NULL,
      refreshed_at TEXT NOT NULL,
      rebuild_status TEXT NOT NULL DEFAULT 'idle',
      pending_from_time TEXT,
      pending_to_time TEXT,
      last_processed_from_time TEXT,
      last_processed_to_time TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS dashboard_snapshot_cache (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      snapshot_json TEXT NOT NULL,
      snapshot_kind TEXT NOT NULL,
      built_at TEXT NOT NULL,
      source_heart_count INTEGER NOT NULL,
      source_last_heart_time TEXT,
      derived_refreshed_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS heart_day_stats (
      day TEXT PRIMARY KEY NOT NULL,
      min_bpm INTEGER NOT NULL,
      avg_bpm REAL NOT NULL,
      max_bpm INTEGER NOT NULL,
      strain_score REAL
    );

    CREATE TABLE IF NOT EXISTS heart_global_stats (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      observed_peak_bpm INTEGER,
      latest_heart_time TEXT,
      latest_stress REAL
    );

    CREATE TABLE IF NOT EXISTS heart_intraday_buckets (
      bucket_start TEXT PRIMARY KEY NOT NULL,
      sample_count INTEGER NOT NULL,
      avg_bpm REAL NOT NULL,
      first_bpm INTEGER NOT NULL,
      second_bpm INTEGER,
      penultimate_bpm INTEGER,
      last_bpm INTEGER NOT NULL,
      max_triplet_avg REAL
    );

    CREATE TABLE IF NOT EXISTS heart_intraday_bucket_state (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      source_heart_count INTEGER NOT NULL,
      source_last_heart_time TEXT,
      refreshed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wellness_day_stats (
      day TEXT PRIMARY KEY NOT NULL,
      stress_count INTEGER NOT NULL,
      avg_stress REAL,
      spo2_count INTEGER NOT NULL,
      avg_spo2 REAL,
      skin_temp_count INTEGER NOT NULL,
      avg_skin_temp REAL
    );

    CREATE TABLE IF NOT EXISTS background_sync_state (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      paired_device_id TEXT,
      last_run_started_at TEXT,
      last_run_finished_at TEXT,
      last_success_at TEXT,
      last_source TEXT,
      last_result TEXT,
      last_error TEXT,
      last_imported_readings INTEGER,
      notification_permission TEXT NOT NULL DEFAULT 'unknown',
      notification_baseline_at TEXT,
      lock_owner TEXT,
      lock_started_at TEXT
    );

    CREATE TABLE IF NOT EXISTS performance_diagnostic_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      run_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      total_elapsed_ms INTEGER NOT NULL,
      app_mode TEXT NOT NULL,
      heart_row_count INTEGER NOT NULL,
      derived_status TEXT,
      derived_pending_from_time TEXT,
      derived_pending_to_time TEXT,
      last_sync_started_at TEXT,
      last_sync_finished_at TEXT,
      last_sync_result TEXT,
      last_sync_imported_readings INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_performance_diagnostic_runs_started_at
      ON performance_diagnostic_runs(started_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS performance_diagnostic_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      run_id INTEGER NOT NULL,
      step_index INTEGER NOT NULL,
      step_key TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      elapsed_ms INTEGER,
      details_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (run_id) REFERENCES performance_diagnostic_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_performance_diagnostic_steps_run_id
      ON performance_diagnostic_steps(run_id, step_index);

    CREATE TABLE IF NOT EXISTS delivered_notifications (
      device_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      delivered_at TEXT NOT NULL,
      PRIMARY KEY (device_id, kind, entity_id)
    );

    CREATE TABLE IF NOT EXISTS sleep_stage_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      sleep_id TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      stage TEXT NOT NULL,
      is_estimated INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_sleep_stage_segments_sleep_id ON sleep_stage_segments(sleep_id);
  `);

  const sleepPreferenceColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(sleep_preferences)');
  const sleepPreferenceColumnNames = new Set(sleepPreferenceColumns.map((column) => column.name));

  if (!sleepPreferenceColumnNames.has('alarm_enabled')) {
    await db.execAsync('ALTER TABLE sleep_preferences ADD COLUMN alarm_enabled INTEGER NOT NULL DEFAULT 0;');
  }

  if (!sleepPreferenceColumnNames.has('alarm_minutes')) {
    await db.execAsync('ALTER TABLE sleep_preferences ADD COLUMN alarm_minutes INTEGER;');
  }

  const deviceStateColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(device_state)');
  const deviceStateColumnNames = new Set(deviceStateColumns.map((column) => column.name));

  if (!deviceStateColumnNames.has('charging_status')) {
    await db.execAsync('ALTER TABLE device_state ADD COLUMN charging_status TEXT;');
  }

  const sleepCycleColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(sleep_cycles)');
  const sleepCycleColumnNames = new Set(sleepCycleColumns.map((column) => column.name));

  if (!sleepCycleColumnNames.has('avg_skin_temp')) {
    await db.execAsync('ALTER TABLE sleep_cycles ADD COLUMN avg_skin_temp REAL;');
  }

  const derivedDataStateColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(derived_data_state)');
  const derivedDataStateColumnNames = new Set(derivedDataStateColumns.map((column) => column.name));

  if (!derivedDataStateColumnNames.has('rebuild_status')) {
    await db.execAsync(`ALTER TABLE derived_data_state ADD COLUMN rebuild_status TEXT NOT NULL DEFAULT 'idle';`);
  }

  if (!derivedDataStateColumnNames.has('pending_from_time')) {
    await db.execAsync('ALTER TABLE derived_data_state ADD COLUMN pending_from_time TEXT;');
  }

  if (!derivedDataStateColumnNames.has('pending_to_time')) {
    await db.execAsync('ALTER TABLE derived_data_state ADD COLUMN pending_to_time TEXT;');
  }

  if (!derivedDataStateColumnNames.has('last_processed_from_time')) {
    await db.execAsync('ALTER TABLE derived_data_state ADD COLUMN last_processed_from_time TEXT;');
  }

  if (!derivedDataStateColumnNames.has('last_processed_to_time')) {
    await db.execAsync('ALTER TABLE derived_data_state ADD COLUMN last_processed_to_time TEXT;');
  }

  if (!derivedDataStateColumnNames.has('last_error')) {
    await db.execAsync('ALTER TABLE derived_data_state ADD COLUMN last_error TEXT;');
  }

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS wellness_day_stats (
      day TEXT PRIMARY KEY NOT NULL,
      stress_count INTEGER NOT NULL,
      avg_stress REAL,
      spo2_count INTEGER NOT NULL,
      avg_spo2 REAL,
      skin_temp_count INTEGER NOT NULL,
      avg_skin_temp REAL
    );
  `);

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS performance_diagnostic_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      run_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      total_elapsed_ms INTEGER NOT NULL,
      app_mode TEXT NOT NULL,
      heart_row_count INTEGER NOT NULL,
      derived_status TEXT,
      derived_pending_from_time TEXT,
      derived_pending_to_time TEXT,
      last_sync_started_at TEXT,
      last_sync_finished_at TEXT,
      last_sync_result TEXT,
      last_sync_imported_readings INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_performance_diagnostic_runs_started_at
      ON performance_diagnostic_runs(started_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS performance_diagnostic_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      run_id INTEGER NOT NULL,
      step_index INTEGER NOT NULL,
      step_key TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      elapsed_ms INTEGER,
      details_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (run_id) REFERENCES performance_diagnostic_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_performance_diagnostic_steps_run_id
      ON performance_diagnostic_steps(run_id, step_index);
  `);

  const activityForeignKeys = await db.getAllAsync<{ table: string }>('PRAGMA foreign_key_list(activities)');
  if (activityForeignKeys.length > 0) {
    await db.execAsync(`
      PRAGMA foreign_keys = OFF;

      CREATE TABLE activities_next (
        id INTEGER PRIMARY KEY NOT NULL,
        period_id TEXT NOT NULL,
        start TEXT NOT NULL UNIQUE,
        end TEXT NOT NULL,
        activity TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO activities_next (id, period_id, start, end, activity, synced)
      SELECT id, period_id, start, end, activity, synced
      FROM activities;

      DROP TABLE activities;
      ALTER TABLE activities_next RENAME TO activities;

      CREATE INDEX idx_activities_start ON activities(start);
      CREATE INDEX idx_activities_end ON activities(end);

      PRAGMA foreign_keys = ON;
    `);
  }
}
