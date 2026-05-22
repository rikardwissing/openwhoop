import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useState } from 'react';

import type { DerivedRefreshState } from '@/types/health';
import { useHealthDataVersion } from '@/providers/HealthDataProvider';
import { getSQLiteApolloClient } from '@/modules/local-sqlite-apollo/src';

const DERIVED_REFRESH_STATE_QUERY = gql`
  query DerivedRefreshState {
    derived_data_state(limit: 1) {
      id
      rebuild_status
      pending_from_time
      pending_to_time
      last_processed_from_time
      last_processed_to_time
      last_error
    }
    heart_rate(limit: 1) {
      id
    }
  }
`;

interface DerivedRefreshStateData {
  derived_data_state: Array<{
    id: number;
    last_error: string | null;
    last_processed_from_time: string | null;
    last_processed_to_time: string | null;
    pending_from_time: string | null;
    pending_to_time: string | null;
    rebuild_status: DerivedRefreshState['status'] | null;
  }>;
  heart_rate: Array<{ id: number }>;
}

type AsyncState<T> =
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: Error };

function buildDerivedRefreshState(data: DerivedRefreshStateData | undefined): DerivedRefreshState {
  const row = data?.derived_data_state[0] ?? null;
  const hasHeartRows = (data?.heart_rate.length ?? 0) > 0;

  if (!row && hasHeartRows) {
    return {
      status: 'pending',
      pendingFromTime: null,
      pendingToTime: null,
      lastProcessedFromTime: null,
      lastProcessedToTime: null,
      lastError: null,
      isFirstSync: true,
    };
  }

  return {
    status: row?.rebuild_status ?? 'idle',
    pendingFromTime: row?.pending_from_time ?? null,
    pendingToTime: row?.pending_to_time ?? null,
    lastProcessedFromTime: row?.last_processed_from_time ?? null,
    lastProcessedToTime: row?.last_processed_to_time ?? null,
    lastError: row?.last_error ?? null,
    isFirstSync: row?.last_processed_from_time === null || row?.last_processed_to_time === null,
  };
}

export async function fetchGraphQLDerivedRefreshState(db: SQLiteDatabase): Promise<DerivedRefreshState> {
  const client = await getSQLiteApolloClient(db);
  const result = await client.query<DerivedRefreshStateData>({
    fetchPolicy: 'network-only',
    query: DERIVED_REFRESH_STATE_QUERY,
  });

  return buildDerivedRefreshState(result.data);
}

export function useGraphQLDerivedRefreshState(): AsyncState<DerivedRefreshState> {
  const version = useHealthDataVersion('derived');
  const [retainedData, setRetainedData] = useState<DerivedRefreshState | null>(null);
  const query = useQuery<DerivedRefreshStateData>(DERIVED_REFRESH_STATE_QUERY, {
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
  });

  useEffect(() => {
    void query.refetch();
  // Apollo refetch is used as the bridge from the existing health version signal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    if (query.data) {
      setRetainedData(buildDerivedRefreshState(query.data));
    }
  }, [query.data]);

  if (query.error) {
    return { status: 'error', data: retainedData, error: query.error };
  }

  if (!retainedData) {
    return { status: 'loading', data: null, error: null };
  }

  return { status: 'ready', data: retainedData, error: null };
}
