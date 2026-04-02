import type { SQLiteDatabase } from 'expo-sqlite';

export const APP_DATABASE_NAME = 'btwearable.db';
export const DERIVED_DATA_SCHEMA_VERSION = 1;

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
      refreshed_at TEXT NOT NULL
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
