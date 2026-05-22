import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useState } from 'react';

import type { ActiveActivity, ManualActivityKind } from '@/data/HealthRepository';
import { getSQLiteApolloClient } from '@/modules/local-sqlite-apollo/src';
import { parseSqliteDateTime } from '@/utils/dateTime';

const ACTIVE_ACTIVITY_QUERY = gql`
  query ActiveActivity {
    active_activities(limit: 1) {
      id
      activity
      start
      created_at
      updated_at
    }
  }
`;

interface ActiveActivityGraphQLData {
  active_activities: Array<{
    activity: string;
    created_at: string;
    id: number;
    start: string;
    updated_at: string;
  }>;
}

type AsyncState<T> =
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: Error };

function normalizeActivityKind(value: string): ManualActivityKind {
  if (value === 'Nap' || value === 'Walk' || value === 'Workout' || value === 'Running') {
    return value;
  }

  return 'Activity';
}

function toActiveActivity(data: ActiveActivityGraphQLData, now = new Date()): ActiveActivity | null {
  const row = data.active_activities[0] ?? null;
  if (!row) {
    return null;
  }

  const start = parseSqliteDateTime(row.start);

  return {
    id: `active-${row.id}`,
    activity: normalizeActivityKind(row.activity),
    start,
    elapsedMinutes: Math.max(0, Math.round((now.getTime() - start.getTime()) / 60_000)),
  };
}

export async function fetchGraphQLActiveActivity(db: SQLiteDatabase): Promise<ActiveActivity | null> {
  const client = await getSQLiteApolloClient(db);
  const result = await client.query<ActiveActivityGraphQLData>({
    fetchPolicy: 'network-only',
    query: ACTIVE_ACTIVITY_QUERY,
  });

  return result.data ? toActiveActivity(result.data) : null;
}

export function useGraphQLActiveActivity(version: number): AsyncState<ActiveActivity | null> {
  const [retainedData, setRetainedData] = useState<ActiveActivity | null>(null);
  const query = useQuery<ActiveActivityGraphQLData>(ACTIVE_ACTIVITY_QUERY, {
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
  });

  useEffect(() => {
    void query.refetch();
  // Apollo refetch is used as the bridge from the existing health version signal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    const interval = setInterval(() => {
      void query.refetch();
    }, 30_000);

    return () => {
      clearInterval(interval);
    };
  }, [query]);

  useEffect(() => {
    if (query.data) {
      setRetainedData(toActiveActivity(query.data));
    }
  }, [query.data]);

  if (query.error) {
    return { status: 'error', data: retainedData, error: query.error };
  }

  if (query.loading && !query.data) {
    return { status: 'loading', data: retainedData, error: null };
  }

  return { status: 'ready', data: retainedData, error: null };
}
