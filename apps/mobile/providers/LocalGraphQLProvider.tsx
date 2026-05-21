import { ApolloProvider } from '@apollo/client/react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useState, type ReactNode } from 'react';

import { getSQLiteApolloClient } from '@/services/graphql/sqliteApolloClient';

type LocalGraphQLClient = Awaited<ReturnType<typeof getSQLiteApolloClient>>;

export function LocalGraphQLProvider({
  children,
  db,
}: {
  children: ReactNode;
  db: SQLiteDatabase;
}) {
  const [client, setClient] = useState<LocalGraphQLClient | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    setClient(null);
    setError(null);

    void getSQLiteApolloClient(db)
      .then((nextClient) => {
        if (!cancelled) {
          setClient(nextClient);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError : new Error(String(nextError)));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [db]);

  if (error) {
    throw error;
  }

  if (!client) {
    return null;
  }

  return <ApolloProvider client={client}>{children}</ApolloProvider>;
}
