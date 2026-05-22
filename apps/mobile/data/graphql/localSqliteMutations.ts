import { gql } from '@apollo/client';
import type { SQLiteDatabase } from 'expo-sqlite';

import type { ManualActivityKind } from '@/data/HealthRepository';
import { getSQLiteApolloClient } from '@/modules/local-sqlite-apollo/src';

interface ActivitySourceRow {
  id: number;
  source: string | null;
}

interface ActiveActivityRow {
  activity: string;
  created_at: string;
  id: number;
  start: string;
  updated_at: string;
}

export interface LocalActivityWrite {
  activity: ManualActivityKind;
  end: string;
  period_id: string;
  review_state: string;
  source: string;
  start: string;
  synced: number;
}

export interface LocalSleepPreferencesWrite {
  alarm_enabled: number;
  alarm_minutes: number;
  alarm_one_off_at: string | null;
  alarm_schedule_kind: string;
  alarm_wake_mode: string;
  alarm_weekday_mask: number;
  id: number;
  target_wake_minutes: number;
  updated_at: string;
}

export interface LocalBackgroundSyncStateWrite {
  id: number;
  last_error: string | null;
  last_imported_readings: number | null;
  last_result: string | null;
  last_run_finished_at: string | null;
  last_run_started_at: string | null;
  last_source: string | null;
  last_success_at: string | null;
  last_sync_import_summary_json: string | null;
  lock_owner: string | null;
  lock_started_at: string | null;
  notification_baseline_at: string | null;
  notification_permission: string;
  paired_device_id: string | null;
}

export interface LocalDeliveredNotificationWrite {
  delivered_at: string;
  device_id: string;
  entity_id: string;
  kind: string;
}

export interface LocalAppIntentEventWrite {
  created_at: string;
  entity_id: string;
  kind: string;
  occurred_at: string;
  payload_json: string;
}

export interface LocalAppleHealthExportStateWrite {
  exported_count: number;
  last_exported_at: string;
  metric_key: string;
  updated_at: string;
}

const ACTIVITY_SOURCE_BY_PK_QUERY = gql`
  query LocalMutationActivitySourceByPk($id: Int!) {
    activities_by_pk(id: $id) {
      id
      source
    }
  }
`;

const INSERT_ACTIVE_ACTIVITY_MUTATION = gql`
  mutation LocalMutationInsertActiveActivity($object: Sqlite_active_activities_insert_input!) {
    insert_active_activities_one(object: $object) {
      id
      activity
      start
      created_at
      updated_at
    }
  }
`;

const UPSERT_ACTIVITY_BY_START_MUTATION = gql`
  mutation LocalMutationUpsertActivityByStart($object: Sqlite_activities_insert_input!) {
    insert_activities_one(
      object: $object
      on_conflict: {
        constraint: activities_start_key
        update_columns: [period_id, end, activity, synced, source, review_state]
      }
    ) {
      id
    }
  }
`;

const DELETE_ACTIVE_ACTIVITY_BY_PK_MUTATION = gql`
  mutation LocalMutationDeleteActiveActivityByPk($id: Int!) {
    delete_active_activities_by_pk(id: $id) {
      id
    }
  }
`;

const UPDATE_ACTIVITY_BY_PK_MUTATION = gql`
  mutation LocalMutationUpdateActivityByPk($id: Int!, $set: Sqlite_activities_set_input!) {
    update_activities_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
      source
    }
  }
`;

const UPSERT_SLEEP_PREFERENCES_MUTATION = gql`
  mutation LocalMutationUpsertSleepPreferences($object: Sqlite_sleep_preferences_insert_input!) {
    insert_sleep_preferences_one(
      object: $object
      on_conflict: {
        constraint: sleep_preferences_pkey
        update_columns: [
          target_wake_minutes
          alarm_enabled
          alarm_minutes
          alarm_schedule_kind
          alarm_weekday_mask
          alarm_wake_mode
          alarm_one_off_at
          updated_at
        ]
      }
    ) {
      id
    }
  }
`;

const UPSERT_BACKGROUND_SYNC_STATE_MUTATION = gql`
  mutation LocalMutationUpsertBackgroundSyncState($object: Sqlite_background_sync_state_insert_input!) {
    insert_background_sync_state_one(
      object: $object
      on_conflict: {
        constraint: background_sync_state_pkey
        update_columns: [
          paired_device_id
          last_run_started_at
          last_run_finished_at
          last_success_at
          last_source
          last_result
          last_error
          last_imported_readings
          notification_permission
          notification_baseline_at
          lock_owner
          lock_started_at
          last_sync_import_summary_json
        ]
      }
    ) {
      id
    }
  }
`;

const UPSERT_DELIVERED_NOTIFICATION_MUTATION = gql`
  mutation LocalMutationUpsertDeliveredNotification($object: Sqlite_delivered_notifications_insert_input!) {
    insert_delivered_notifications(
      objects: [$object]
      on_conflict: {
        constraint: delivered_notifications_pkey
        update_columns: []
      }
    ) {
      affected_rows
    }
  }
`;

const DELETE_DELIVERED_NOTIFICATION_MUTATION = gql`
  mutation LocalMutationDeleteDeliveredNotification($deviceId: String!, $kind: String!, $entityId: String!) {
    delete_delivered_notifications(
      where: {
        device_id: { _eq: $deviceId }
        kind: { _eq: $kind }
        entity_id: { _eq: $entityId }
      }
    ) {
      affected_rows
    }
  }
`;

const DELETE_DELIVERED_NOTIFICATION_ENTITIES_MUTATION = gql`
  mutation LocalMutationDeleteDeliveredNotificationEntities(
    $deviceId: String!
    $kind: String!
    $entityIds: [String]
  ) {
    delete_delivered_notifications(
      where: {
        device_id: { _eq: $deviceId }
        kind: { _eq: $kind }
        entity_id: { _in: $entityIds }
      }
    ) {
      affected_rows
    }
  }
`;

const CLEAR_BACKGROUND_SYNC_STATE_MUTATION = gql`
  mutation LocalMutationClearBackgroundSyncState {
    delete_delivered_notifications(where: {}) {
      affected_rows
    }
    delete_background_sync_state(where: {}) {
      affected_rows
    }
  }
`;

const UPSERT_APP_INTENT_EVENT_MUTATION = gql`
  mutation LocalMutationUpsertAppIntentEvent($object: Sqlite_app_intent_events_insert_input!) {
    insert_app_intent_events_one(
      object: $object
      on_conflict: {
        constraint: app_intent_events_kind_entity_id_key
        update_columns: [occurred_at, payload_json]
      }
    ) {
      id
    }
  }
`;

const UPSERT_APPLE_HEALTH_EXPORT_STATE_MUTATION = gql`
  mutation LocalMutationUpsertAppleHealthExportState($object: Sqlite_apple_health_export_state_insert_input!) {
    insert_apple_health_export_state_one(
      object: $object
      on_conflict: {
        constraint: apple_health_export_state_pkey
        update_columns: [last_exported_at, exported_count, updated_at]
      }
    ) {
      metric_key
    }
  }
`;

const DELETE_APPLE_HEALTH_EXPORT_STATE_BY_PK_MUTATION = gql`
  mutation LocalMutationDeleteAppleHealthExportStateByPk($metricKey: String!) {
    delete_apple_health_export_state_by_pk(metric_key: $metricKey) {
      metric_key
    }
  }
`;

const EXPIRE_PAST_ONE_OFF_SLEEP_ALARM_MUTATION = gql`
  mutation LocalMutationExpirePastOneOffSleepAlarm($now: String!) {
    update_sleep_preferences(
      where: {
        id: { _eq: 1 }
        alarm_enabled: { _eq: 1 }
        alarm_schedule_kind: { _eq: "one_off" }
        alarm_one_off_at: { _is_null: false, _lte: $now }
      }
      _set: { alarm_enabled: 0, alarm_one_off_at: null, updated_at: $now }
    ) {
      affected_rows
    }
  }
`;

const MARK_ONE_OFF_SLEEP_ALARM_EXECUTED_MUTATION = gql`
  mutation LocalMutationMarkOneOffSleepAlarmExecuted($executedAt: String!) {
    update_sleep_preferences(
      where: {
        id: { _eq: 1 }
        alarm_enabled: { _eq: 1 }
        alarm_schedule_kind: { _eq: "one_off" }
      }
      _set: { alarm_enabled: 0, alarm_one_off_at: null, updated_at: $executedAt }
    ) {
      affected_rows
    }
  }
`;

export async function insertLocalActiveActivity(
  db: SQLiteDatabase,
  object: {
    activity: ManualActivityKind;
    created_at: string;
    id: number;
    start: string;
    updated_at: string;
  },
) {
  const client = await getSQLiteApolloClient(db);
  const result = await client.mutate<{ insert_active_activities_one: ActiveActivityRow | null }>({
    mutation: INSERT_ACTIVE_ACTIVITY_MUTATION,
    variables: { object },
  });

  return result.data?.insert_active_activities_one ?? null;
}

export async function deleteLocalActiveActivityById(db: SQLiteDatabase, id: number) {
  const client = await getSQLiteApolloClient(db);
  await client.mutate({
    mutation: DELETE_ACTIVE_ACTIVITY_BY_PK_MUTATION,
    variables: { id },
  });
}

export async function upsertLocalManualActivityByStart(
  db: SQLiteDatabase,
  object: LocalActivityWrite,
) {
  const client = await getSQLiteApolloClient(db);
  const result = await client.mutate<{ insert_activities_one: { id: number } | null }, { object: LocalActivityWrite }>({
    mutation: UPSERT_ACTIVITY_BY_START_MUTATION,
    variables: { object },
  });

  return result.data?.insert_activities_one?.id ?? null;
}

export async function loadLocalActivitySourceById(db: SQLiteDatabase, id: number) {
  const client = await getSQLiteApolloClient(db);
  const result = await client.query<{ activities_by_pk: ActivitySourceRow | null }, { id: number }>({
    fetchPolicy: 'network-only',
    query: ACTIVITY_SOURCE_BY_PK_QUERY,
    variables: { id },
  });

  return result.data?.activities_by_pk ?? null;
}

export async function updateLocalActivityById(
  db: SQLiteDatabase,
  id: number,
  set: Partial<LocalActivityWrite>,
) {
  const client = await getSQLiteApolloClient(db);
  const result = await client.mutate<
    { update_activities_by_pk: ActivitySourceRow | null },
    { id: number; set: Partial<LocalActivityWrite> }
  >({
    mutation: UPDATE_ACTIVITY_BY_PK_MUTATION,
    variables: {
      id,
      set,
    },
  });

  return result.data?.update_activities_by_pk ?? null;
}

export async function upsertLocalSleepPreferences(
  db: SQLiteDatabase,
  object: LocalSleepPreferencesWrite,
) {
  const client = await getSQLiteApolloClient(db);
  await client.mutate<{ insert_sleep_preferences_one: { id: number } | null }, { object: LocalSleepPreferencesWrite }>({
    mutation: UPSERT_SLEEP_PREFERENCES_MUTATION,
    variables: { object },
  });
}

export async function upsertLocalBackgroundSyncState(
  db: SQLiteDatabase,
  object: LocalBackgroundSyncStateWrite,
) {
  const client = await getSQLiteApolloClient(db);
  await client.mutate<
    { insert_background_sync_state_one: { id: number } | null },
    { object: LocalBackgroundSyncStateWrite }
  >({
    mutation: UPSERT_BACKGROUND_SYNC_STATE_MUTATION,
    variables: { object },
  });
}

export async function reserveLocalDeliveredNotification(
  db: SQLiteDatabase,
  object: LocalDeliveredNotificationWrite,
) {
  const client = await getSQLiteApolloClient(db);
  const result = await client.mutate<
    { insert_delivered_notifications: { affected_rows: number } },
    { object: LocalDeliveredNotificationWrite }
  >({
    mutation: UPSERT_DELIVERED_NOTIFICATION_MUTATION,
    variables: { object },
  });

  return (result.data?.insert_delivered_notifications.affected_rows ?? 0) > 0;
}

export async function deleteLocalDeliveredNotification(
  db: SQLiteDatabase,
  variables: {
    deviceId: string;
    entityId: string;
    kind: string;
  },
) {
  const client = await getSQLiteApolloClient(db);
  await client.mutate({
    mutation: DELETE_DELIVERED_NOTIFICATION_MUTATION,
    variables,
  });
}

export async function deleteLocalDeliveredNotificationEntities(
  db: SQLiteDatabase,
  variables: {
    deviceId: string;
    entityIds: string[];
    kind: string;
  },
) {
  if (variables.entityIds.length === 0) {
    return;
  }

  const client = await getSQLiteApolloClient(db);
  await client.mutate({
    mutation: DELETE_DELIVERED_NOTIFICATION_ENTITIES_MUTATION,
    variables,
  });
}

export async function clearLocalBackgroundSyncState(db: SQLiteDatabase) {
  const client = await getSQLiteApolloClient(db);
  await client.mutate({ mutation: CLEAR_BACKGROUND_SYNC_STATE_MUTATION });
}

export async function upsertLocalAppIntentEvent(
  db: SQLiteDatabase,
  object: LocalAppIntentEventWrite,
) {
  const client = await getSQLiteApolloClient(db);
  await client.mutate<{ insert_app_intent_events_one: { id: number } | null }, { object: LocalAppIntentEventWrite }>({
    mutation: UPSERT_APP_INTENT_EVENT_MUTATION,
    variables: { object },
  });
}

export async function upsertLocalAppleHealthExportState(
  db: SQLiteDatabase,
  object: LocalAppleHealthExportStateWrite,
) {
  const client = await getSQLiteApolloClient(db);
  await client.mutate<
    { insert_apple_health_export_state_one: { metric_key: string } | null },
    { object: LocalAppleHealthExportStateWrite }
  >({
    mutation: UPSERT_APPLE_HEALTH_EXPORT_STATE_MUTATION,
    variables: { object },
  });
}

export async function deleteLocalAppleHealthExportState(db: SQLiteDatabase, metricKey: string) {
  const client = await getSQLiteApolloClient(db);
  await client.mutate({
    mutation: DELETE_APPLE_HEALTH_EXPORT_STATE_BY_PK_MUTATION,
    variables: { metricKey },
  });
}

export async function expirePastOneOffSleepAlarmViaMutation(db: SQLiteDatabase, nowSql: string) {
  const client = await getSQLiteApolloClient(db);
  await client.mutate({
    mutation: EXPIRE_PAST_ONE_OFF_SLEEP_ALARM_MUTATION,
    variables: { now: nowSql },
  });
}

export async function markOneOffSleepAlarmExecutedViaMutation(db: SQLiteDatabase, executedAtSql: string) {
  const client = await getSQLiteApolloClient(db);
  await client.mutate({
    mutation: MARK_ONE_OFF_SLEEP_ALARM_EXECUTED_MUTATION,
    variables: { executedAt: executedAtSql },
  });
}
