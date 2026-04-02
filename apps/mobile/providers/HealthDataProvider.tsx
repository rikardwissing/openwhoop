import { createContext, useContext, useState, type ReactNode } from 'react';
import { useSQLiteContext } from 'expo-sqlite';

import type { HealthRepository } from '@/data/HealthRepository';
import { SQLiteHealthRepository } from '@/data/sqlite/SQLiteHealthRepository';

const HealthRepositoryContext = createContext<HealthRepository | null>(null);

function SQLiteRepositoryProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const [value] = useState<HealthRepository>(() => new SQLiteHealthRepository(db));

  return (
    <HealthRepositoryContext.Provider value={value}>
      {children}
    </HealthRepositoryContext.Provider>
  );
}

export function HealthDataProvider({
  children,
  repository,
}: {
  children: ReactNode;
  repository?: HealthRepository;
}) {
  if (repository) {
    return (
      <HealthRepositoryContext.Provider value={repository}>
        {children}
      </HealthRepositoryContext.Provider>
    );
  }

  return <SQLiteRepositoryProvider>{children}</SQLiteRepositoryProvider>;
}

export function useHealthRepository() {
  const repository = useContext(HealthRepositoryContext);

  if (!repository) {
    throw new Error('Health repository is not available.');
  }

  return repository;
}
