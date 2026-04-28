import type { SQLiteDatabase } from 'expo-sqlite';

export const APP_DATABASE_NAME = 'btwearable.db';
export const DERIVED_DATA_SCHEMA_VERSION = 8;

const HEART_RATE_TABLE_COLUMNS_SQL = `
  id INTEGER PRIMARY KEY NOT NULL,
  bpm INTEGER NOT NULL,
  time TEXT NOT NULL UNIQUE,
  rr_intervals TEXT NOT NULL,
  stress REAL,
  ppg_green INTEGER,
  ppg_red_ir INTEGER,
  spo2_red INTEGER,
  spo2_ir INTEGER,
  skin_temp_raw INTEGER,
  ambient_light INTEGER,
  led_drive_1 INTEGER,
  led_drive_2 INTEGER,
  resp_rate_raw INTEGER,
  signal_quality INTEGER,
  skin_contact INTEGER,
  accel_gravity_x REAL,
  accel_gravity_y REAL,
  accel_gravity_z REAL,
  spo2 REAL,
  skin_temp REAL
`;

const HEART_RATE_TABLE_SELECT_COLUMNS = `
  id,
  bpm,
  time,
  rr_intervals,
  stress,
  ppg_green,
  ppg_red_ir,
  spo2_red,
  spo2_ir,
  skin_temp_raw,
  ambient_light,
  led_drive_1,
  led_drive_2,
  resp_rate_raw,
  signal_quality,
  skin_contact,
  accel_gravity_x,
  accel_gravity_y,
  accel_gravity_z,
  spo2,
  skin_temp
`;

const HEART_RATE_OPTIONAL_COLUMN_DEFINITIONS = {
  stress: 'REAL',
  ppg_green: 'INTEGER',
  ppg_red_ir: 'INTEGER',
  spo2_red: 'INTEGER',
  spo2_ir: 'INTEGER',
  skin_temp_raw: 'INTEGER',
  ambient_light: 'INTEGER',
  led_drive_1: 'INTEGER',
  led_drive_2: 'INTEGER',
  resp_rate_raw: 'INTEGER',
  signal_quality: 'INTEGER',
  skin_contact: 'INTEGER',
  accel_gravity_x: 'REAL',
  accel_gravity_y: 'REAL',
  accel_gravity_z: 'REAL',
  spo2: 'REAL',
  skin_temp: 'REAL',
} as const;

function buildCreateHeartRateTableSql(tableName: string, options?: { ifNotExists?: boolean }) {
  const ifNotExistsClause = options?.ifNotExists ? ' IF NOT EXISTS' : '';

  return `
    CREATE TABLE${ifNotExistsClause} ${tableName} (
      ${HEART_RATE_TABLE_COLUMNS_SQL}
    );
  `;
}

async function getHeartRateColumnNames(db: SQLiteDatabase) {
  const heartRateColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(heart_rate)');
  return new Set(heartRateColumns.map((column) => column.name));
}

async function ensureHeartRateOptionalColumns(db: SQLiteDatabase) {
  const heartRateColumnNames = await getHeartRateColumnNames(db);

  for (const [columnName, columnType] of Object.entries(HEART_RATE_OPTIONAL_COLUMN_DEFINITIONS)) {
    if (heartRateColumnNames.has(columnName)) {
      continue;
    }

    await db.execAsync(`ALTER TABLE heart_rate ADD COLUMN ${columnName} ${columnType};`);
    heartRateColumnNames.add(columnName);
  }
}

export async function rewriteHeartRateTable(db: SQLiteDatabase) {
  await ensureHeartRateOptionalColumns(db);

  await db.execAsync('PRAGMA foreign_keys = OFF;');

  try {
    await db.execAsync(`
      BEGIN IMMEDIATE;

      DROP TABLE IF EXISTS heart_rate_next;

      ${buildCreateHeartRateTableSql('heart_rate_next')}

      INSERT INTO heart_rate_next (${HEART_RATE_TABLE_SELECT_COLUMNS})
      SELECT ${HEART_RATE_TABLE_SELECT_COLUMNS}
      FROM heart_rate;

      DROP TABLE heart_rate;
      ALTER TABLE heart_rate_next RENAME TO heart_rate;

      COMMIT;
    `);
  } catch (error) {
    try {
      await db.execAsync('ROLLBACK; DROP TABLE IF EXISTS heart_rate_next;');
    } catch {}

    throw error;
  } finally {
    await db.execAsync('PRAGMA foreign_keys = ON;');
  }
}

export async function migrateLegacyHeartRateTable(db: SQLiteDatabase) {
  await rewriteHeartRateTable(db);
}

export async function initializeDatabase(db: SQLiteDatabase) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 10000;
    PRAGMA foreign_keys = ON;

    ${buildCreateHeartRateTableSql('heart_rate', { ifNotExists: true })}

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
      synced INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'detected',
      review_state TEXT NOT NULL DEFAULT 'none',
      completion_status TEXT NOT NULL DEFAULT 'complete'
    );

    CREATE INDEX IF NOT EXISTS idx_sleep_cycles_start ON sleep_cycles(start);
    CREATE INDEX IF NOT EXISTS idx_sleep_cycles_end ON sleep_cycles(end);

    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL,
      start TEXT NOT NULL UNIQUE,
      end TEXT NOT NULL,
      activity TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0,
      confidence REAL,
      source TEXT NOT NULL DEFAULT 'detected',
      review_state TEXT NOT NULL DEFAULT 'none'
    );

    CREATE INDEX IF NOT EXISTS idx_activities_start ON activities(start);
    CREATE INDEX IF NOT EXISTS idx_activities_end ON activities(end);

    CREATE TABLE IF NOT EXISTS activity_personalization (
      activity_kind TEXT NOT NULL,
      daypart TEXT NOT NULL,
      positive_count INTEGER NOT NULL DEFAULT 0,
      negative_count INTEGER NOT NULL DEFAULT 0,
      min_duration_minutes REAL NOT NULL,
      min_confidence REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (activity_kind, daypart)
    );

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

    DROP TABLE IF EXISTS dashboard_snapshot_cache;

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

    DROP TABLE IF EXISTS heart_intraday_buckets;

    CREATE TABLE IF NOT EXISTS heart_intraday_bucket_state (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      source_heart_count INTEGER NOT NULL,
      source_last_heart_time TEXT,
      refreshed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS intraday_metric_buckets (
      metric_key TEXT NOT NULL,
      bucket_seconds INTEGER NOT NULL,
      bucket_start TEXT NOT NULL,
      sample_count INTEGER NOT NULL,
      min_value REAL,
      avg_value REAL,
      max_value REAL,
      first_value REAL,
      last_value REAL,
      PRIMARY KEY (metric_key, bucket_seconds, bucket_start)
    );

    CREATE INDEX IF NOT EXISTS idx_intraday_metric_buckets_lookup
      ON intraday_metric_buckets(metric_key, bucket_seconds, bucket_start);

    CREATE TABLE IF NOT EXISTS intraday_metric_bucket_state (
      metric_key TEXT NOT NULL,
      bucket_seconds INTEGER NOT NULL,
      source_row_count INTEGER NOT NULL,
      source_last_sample_time TEXT,
      refreshed_at TEXT NOT NULL,
      PRIMARY KEY (metric_key, bucket_seconds)
    );

    CREATE TABLE IF NOT EXISTS heart_intraday_bucket_details (
      bucket_seconds INTEGER NOT NULL,
      bucket_start TEXT NOT NULL,
      second_bpm INTEGER,
      penultimate_bpm INTEGER,
      max_triplet_avg REAL,
      PRIMARY KEY (bucket_seconds, bucket_start)
    );

    CREATE TABLE IF NOT EXISTS sleep_feature_buckets (
      bucket_seconds INTEGER NOT NULL,
      bucket_start TEXT NOT NULL,
      sample_count INTEGER NOT NULL,
      min_bpm INTEGER,
      avg_bpm REAL,
      max_bpm INTEGER,
      rr_intervals TEXT NOT NULL DEFAULT '',
      ppg_green_median REAL,
      ppg_green_max REAL,
      awake_ppg_count INTEGER NOT NULL DEFAULT 0,
      saturated_ppg_count INTEGER NOT NULL DEFAULT 0,
      motion_score REAL,
      gravity_x REAL,
      gravity_y REAL,
      gravity_z REAL,
      skin_contact_count INTEGER NOT NULL DEFAULT 0,
      skin_contact_present_count INTEGER NOT NULL DEFAULT 0,
      signal_quality_count INTEGER NOT NULL DEFAULT 0,
      signal_quality_present_count INTEGER NOT NULL DEFAULT 0,
      avg_skin_temp REAL,
      avg_spo2 REAL,
      PRIMARY KEY (bucket_seconds, bucket_start)
    );

    CREATE INDEX IF NOT EXISTS idx_sleep_feature_buckets_lookup
      ON sleep_feature_buckets(bucket_seconds, bucket_start);

    CREATE TABLE IF NOT EXISTS sleep_feature_bucket_state (
      bucket_seconds INTEGER PRIMARY KEY NOT NULL,
      source_row_count INTEGER NOT NULL,
      source_last_sample_time TEXT,
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
      lock_started_at TEXT,
      last_sync_import_summary_json TEXT
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

  await ensureHeartRateOptionalColumns(db);

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
    sleepCycleColumnNames.add('avg_skin_temp');
  }

  if (!sleepCycleColumnNames.has('source')) {
    await db.execAsync("ALTER TABLE sleep_cycles ADD COLUMN source TEXT NOT NULL DEFAULT 'detected';");
    sleepCycleColumnNames.add('source');
  }

  if (!sleepCycleColumnNames.has('review_state')) {
    await db.execAsync("ALTER TABLE sleep_cycles ADD COLUMN review_state TEXT NOT NULL DEFAULT 'none';");
    sleepCycleColumnNames.add('review_state');
  }

  if (!sleepCycleColumnNames.has('completion_status')) {
    await db.execAsync("ALTER TABLE sleep_cycles ADD COLUMN completion_status TEXT NOT NULL DEFAULT 'complete';");
    sleepCycleColumnNames.add('completion_status');
  }

  await db.execAsync('CREATE INDEX IF NOT EXISTS idx_sleep_cycles_source_review ON sleep_cycles(source, review_state);');

  const activityColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(activities)');
  const activityColumnNames = new Set(activityColumns.map((column) => column.name));

  if (!activityColumnNames.has('source')) {
    await db.execAsync("ALTER TABLE activities ADD COLUMN source TEXT NOT NULL DEFAULT 'detected';");
    activityColumnNames.add('source');
  }

  if (!activityColumnNames.has('review_state')) {
    await db.execAsync("ALTER TABLE activities ADD COLUMN review_state TEXT NOT NULL DEFAULT 'none';");
    activityColumnNames.add('review_state');
  }

  if (!activityColumnNames.has('confidence')) {
    await db.execAsync('ALTER TABLE activities ADD COLUMN confidence REAL;');
    activityColumnNames.add('confidence');
  }

  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_activities_source ON activities(source);
    CREATE INDEX IF NOT EXISTS idx_activities_review_state ON activities(review_state);
  `);

  const activityPersonalizationColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(activity_personalization)');
  const activityPersonalizationColumnNames = new Set(activityPersonalizationColumns.map((column) => column.name));

  if (activityPersonalizationColumns.length > 0 && !activityPersonalizationColumnNames.has('daypart')) {
    await db.execAsync(`
      DROP TABLE IF EXISTS activity_personalization;

      CREATE TABLE activity_personalization (
        activity_kind TEXT NOT NULL,
        daypart TEXT NOT NULL,
        positive_count INTEGER NOT NULL DEFAULT 0,
        negative_count INTEGER NOT NULL DEFAULT 0,
        min_duration_minutes REAL NOT NULL,
        min_confidence REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (activity_kind, daypart)
      );
    `);
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

  const backgroundSyncStateColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(background_sync_state)');
  const backgroundSyncStateColumnNames = new Set(backgroundSyncStateColumns.map((column) => column.name));

  if (!backgroundSyncStateColumnNames.has('last_sync_import_summary_json')) {
    await db.execAsync('ALTER TABLE background_sync_state ADD COLUMN last_sync_import_summary_json TEXT;');
  }

  if (!derivedDataStateColumnNames.has('last_processed_to_time')) {
    await db.execAsync('ALTER TABLE derived_data_state ADD COLUMN last_processed_to_time TEXT;');
  }

  if (!derivedDataStateColumnNames.has('last_error')) {
    await db.execAsync('ALTER TABLE derived_data_state ADD COLUMN last_error TEXT;');
  }

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS sleep_feature_buckets (
      bucket_seconds INTEGER NOT NULL,
      bucket_start TEXT NOT NULL,
      sample_count INTEGER NOT NULL,
      min_bpm INTEGER,
      avg_bpm REAL,
      max_bpm INTEGER,
      rr_intervals TEXT NOT NULL DEFAULT '',
      ppg_green_median REAL,
      ppg_green_max REAL,
      awake_ppg_count INTEGER NOT NULL DEFAULT 0,
      saturated_ppg_count INTEGER NOT NULL DEFAULT 0,
      motion_score REAL,
      gravity_x REAL,
      gravity_y REAL,
      gravity_z REAL,
      skin_contact_count INTEGER NOT NULL DEFAULT 0,
      skin_contact_present_count INTEGER NOT NULL DEFAULT 0,
      signal_quality_count INTEGER NOT NULL DEFAULT 0,
      signal_quality_present_count INTEGER NOT NULL DEFAULT 0,
      avg_skin_temp REAL,
      avg_spo2 REAL,
      PRIMARY KEY (bucket_seconds, bucket_start)
    );

    CREATE INDEX IF NOT EXISTS idx_sleep_feature_buckets_lookup
      ON sleep_feature_buckets(bucket_seconds, bucket_start);

    CREATE TABLE IF NOT EXISTS sleep_feature_bucket_state (
      bucket_seconds INTEGER PRIMARY KEY NOT NULL,
      source_row_count INTEGER NOT NULL,
      source_last_sample_time TEXT,
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
    const activitySourceSelect = activityColumnNames.has('source') ? 'source' : "'detected'";
    const activityReviewStateSelect = activityColumnNames.has('review_state') ? 'review_state' : "'none'";
    const activityConfidenceSelect = activityColumnNames.has('confidence') ? 'confidence' : 'NULL';

    await db.execAsync(`
      PRAGMA foreign_keys = OFF;

      CREATE TABLE activities_next (
        id INTEGER PRIMARY KEY NOT NULL,
        period_id TEXT NOT NULL,
        start TEXT NOT NULL UNIQUE,
        end TEXT NOT NULL,
        activity TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0,
        confidence REAL,
        source TEXT NOT NULL DEFAULT 'detected',
        review_state TEXT NOT NULL DEFAULT 'none'
      );

      INSERT INTO activities_next (id, period_id, start, end, activity, synced, confidence, source, review_state)
      SELECT
        id,
        period_id,
        start,
        end,
        activity,
        synced,
        ${activityConfidenceSelect},
        COALESCE(${activitySourceSelect}, 'detected'),
        COALESCE(${activityReviewStateSelect}, 'none')
      FROM activities;

      DROP TABLE activities;
      ALTER TABLE activities_next RENAME TO activities;

      CREATE INDEX idx_activities_start ON activities(start);
      CREATE INDEX idx_activities_end ON activities(end);
      CREATE INDEX idx_activities_source ON activities(source);
      CREATE INDEX idx_activities_review_state ON activities(review_state);

      PRAGMA foreign_keys = ON;
    `);
  }
}
