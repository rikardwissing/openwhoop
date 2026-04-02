import type { SQLiteDatabase } from 'expo-sqlite';

export const APP_DATABASE_NAME = 'btwearable.db';

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
}
