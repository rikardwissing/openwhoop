import { gql } from '@apollo/client';
import type { SQLiteDatabase } from 'expo-sqlite';

import type { ManualActivityKind } from '@/data/HealthRepository';
import { getSQLiteApolloClient } from '@/modules/local-sqlite-apollo/src';

interface ActivityIdRow {
  id: number;
}

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

const ACTIVITY_BY_START_QUERY = gql`
  query LocalMutationActivityByStart($start: String!) {
    activities(where: { start: { _eq: $start } }, limit: 1) {
      id
    }
  }
`;

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

const INSERT_ACTIVITY_MUTATION = gql`
  mutation LocalMutationInsertActivity($object: Sqlite_activities_insert_input!) {
    insert_activities_one(object: $object) {
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

const UPDATE_SLEEP_PREFERENCES_BY_PK_MUTATION = gql`
  mutation LocalMutationUpdateSleepPreferencesByPk($set: Sqlite_sleep_preferences_set_input!) {
    update_sleep_preferences_by_pk(pk_columns: { id: 1 }, _set: $set) {
      id
    }
  }
`;

const INSERT_SLEEP_PREFERENCES_MUTATION = gql`
  mutation LocalMutationInsertSleepPreferences($object: Sqlite_sleep_preferences_insert_input!) {
    insert_sleep_preferences_one(object: $object) {
      id
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

export async function upsertLocalManualActivityByStart(
  db: SQLiteDatabase,
  object: LocalActivityWrite,
) {
  const client = await getSQLiteApolloClient(db);
  const existing = await client.query<{ activities: ActivityIdRow[] }, { start: string }>({
    fetchPolicy: 'network-only',
    query: ACTIVITY_BY_START_QUERY,
    variables: { start: object.start },
  });
  const existingId = existing.data?.activities[0]?.id ?? null;

  if (existingId !== null) {
    const result = await client.mutate<
      { update_activities_by_pk: ActivitySourceRow | null },
      { id: number; set: LocalActivityWrite }
    >({
      mutation: UPDATE_ACTIVITY_BY_PK_MUTATION,
      variables: {
        id: existingId,
        set: object,
      },
    });

    return result.data?.update_activities_by_pk?.id ?? existingId;
  }

  const result = await client.mutate<{ insert_activities_one: ActivityIdRow | null }, { object: LocalActivityWrite }>({
    mutation: INSERT_ACTIVITY_MUTATION,
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
  const updateResult = await client.mutate<
    { update_sleep_preferences_by_pk: { id: number } | null },
    { set: LocalSleepPreferencesWrite }
  >({
    mutation: UPDATE_SLEEP_PREFERENCES_BY_PK_MUTATION,
    variables: {
      set: object,
    },
  });

  if (updateResult.data?.update_sleep_preferences_by_pk) {
    return;
  }

  await client.mutate<{ insert_sleep_preferences_one: { id: number } | null }, { object: LocalSleepPreferencesWrite }>({
    mutation: INSERT_SLEEP_PREFERENCES_MUTATION,
    variables: { object },
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
