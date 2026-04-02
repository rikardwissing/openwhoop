import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSQLiteContext } from 'expo-sqlite';

import type { HealthRepository } from '@/data/HealthRepository';
import { SQLiteHealthRepository } from '@/data/sqlite/SQLiteHealthRepository';

interface HealthRepositoryContextValue {
  repository: HealthRepository;
  version: number;
  refresh: () => void;
}

const HealthRepositoryContext = createContext<HealthRepositoryContextValue | null>(null);

function SQLiteRepositoryProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const [repository] = useState<HealthRepository>(() => new SQLiteHealthRepository(db));
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => {
    repository.invalidateCaches('all');
    setVersion((current) => current + 1);
  }, [repository]);

  useEffect(() => {
    void repository.warmCaches().catch(() => {});
  }, [repository]);

  const value = useMemo(
    () => ({
      repository,
      version,
      refresh,
    }),
    [refresh, repository, version],
  );

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
  const resolvedRepository = repository;
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => {
    resolvedRepository?.invalidateCaches('all');
    setVersion((current) => current + 1);
  }, [resolvedRepository]);

  useEffect(() => {
    if (!resolvedRepository) {
      return;
    }

    void resolvedRepository.warmCaches().catch(() => {});
  }, [resolvedRepository]);

  if (resolvedRepository) {
    const value = {
      repository: resolvedRepository,
      version,
      refresh,
    };
    return (
      <HealthRepositoryContext.Provider value={value}>
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

  return repository.repository;
}

export function useHealthDataVersion() {
  const value = useContext(HealthRepositoryContext);

  if (!value) {
    throw new Error('Health repository is not available.');
  }

  return value.version;
}

export function useRefreshHealthData() {
  const value = useContext(HealthRepositoryContext);

  if (!value) {
    throw new Error('Health repository is not available.');
  }

  return value.refresh;
}
