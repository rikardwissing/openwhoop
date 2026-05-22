import type { SQLiteDatabase } from 'expo-sqlite';

import { upsertLocalAppIntentEvent } from '@/data/graphql/localSqliteMutations';
import { formatSqliteDateTime } from '@/utils/dateTime';

export const APP_INTENT_EVENT_KINDS = [
  'wearable_alarm',
  'bedtime_start',
  'falling_asleep',
  'waking_up',
  'sleep_score_100',
] as const;

export type AppIntentEventKind = typeof APP_INTENT_EVENT_KINDS[number];

export interface AppIntentEventInput {
  entityId: string;
  kind: AppIntentEventKind;
  occurredAt?: Date;
  payload?: Record<string, unknown>;
}

async function ensureAppIntentEventsTable(db: SQLiteDatabase) {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS app_intent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      handled_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (kind, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_app_intent_events_lookup
      ON app_intent_events(kind, occurred_at, handled_at);
  `);
}

export async function recordAppIntentEvent(
  db: SQLiteDatabase,
  event: AppIntentEventInput,
) {
  await ensureAppIntentEventsTable(db);

  const occurredAt = event.occurredAt ?? new Date();
  const payload = JSON.stringify({
    event: event.kind,
    entityId: event.entityId,
    occurredAt: occurredAt.toISOString(),
    ...(event.payload ?? {}),
  });

  await upsertLocalAppIntentEvent(db, {
    kind: event.kind,
    entity_id: event.entityId,
    occurred_at: formatSqliteDateTime(occurredAt),
    payload_json: payload,
    created_at: formatSqliteDateTime(new Date()),
  });
}
