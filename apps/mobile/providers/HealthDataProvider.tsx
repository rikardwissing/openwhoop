import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useSQLiteContext } from 'expo-sqlite';

import type { HealthRefreshScope, HealthRepository } from '@/data/HealthRepository';
import { SQLiteHealthRepository } from '@/data/sqlite/SQLiteHealthRepository';

interface HealthVersionState {
  dashboard: number;
  sleep: number;
  heart: number;
  wellness: number;
  trends: number;
  derived: number;
}

const INITIAL_VERSIONS: HealthVersionState = {
  dashboard: 0,
  sleep: 0,
  heart: 0,
  wellness: 0,
  trends: 0,
  derived: 0,
};

const ALL_REFRESH_SCOPES: Array<Exclude<HealthRefreshScope, 'all'>> = [
  'dashboard',
  'sleep',
  'heart',
  'wellness',
  'trends',
  'derived',
];

const HealthRepositoryContext = createContext<HealthRepository | null>(null);
const HealthRefreshContext = createContext<
  ((scope?: HealthRefreshScope | readonly HealthRefreshScope[]) => void) | null
>(null);
const DashboardVersionContext = createContext(0);
const SleepVersionContext = createContext(0);
const HeartVersionContext = createContext(0);
const WellnessVersionContext = createContext(0);
const TrendsVersionContext = createContext(0);
const DerivedVersionContext = createContext(0);

function normalizeScopes(scope: HealthRefreshScope | readonly HealthRefreshScope[] = 'all') {
  const scopes = Array.isArray(scope) ? [...scope] : [scope];
  return scopes.includes('all') ? ALL_REFRESH_SCOPES : scopes;
}

function bumpVersions(
  current: HealthVersionState,
  scopes: Array<Exclude<HealthRefreshScope, 'all'>>,
): HealthVersionState {
  const next = { ...current };

  for (const scope of scopes) {
    next[scope] += 1;
  }

  return next;
}

function HealthRepositoryProvider({
  children,
  repository,
}: {
  children: ReactNode;
  repository: HealthRepository;
}) {
  const [versions, setVersions] = useState(INITIAL_VERSIONS);
  const refresh = useCallback(
    (scope: HealthRefreshScope | readonly HealthRefreshScope[] = 'all') => {
      const scopes = normalizeScopes(scope);
      setVersions((current) => bumpVersions(current, scopes));
    },
    [],
  );

  return (
    <HealthRepositoryContext.Provider value={repository}>
      <HealthRefreshContext.Provider value={refresh}>
        <DashboardVersionContext.Provider value={versions.dashboard}>
          <SleepVersionContext.Provider value={versions.sleep}>
            <HeartVersionContext.Provider value={versions.heart}>
              <WellnessVersionContext.Provider value={versions.wellness}>
                <TrendsVersionContext.Provider value={versions.trends}>
                  <DerivedVersionContext.Provider value={versions.derived}>
                    {children}
                  </DerivedVersionContext.Provider>
                </TrendsVersionContext.Provider>
              </WellnessVersionContext.Provider>
            </HeartVersionContext.Provider>
          </SleepVersionContext.Provider>
        </DashboardVersionContext.Provider>
      </HealthRefreshContext.Provider>
    </HealthRepositoryContext.Provider>
  );
}

function SQLiteRepositoryProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const [repository] = useState<HealthRepository>(() => new SQLiteHealthRepository(db));

  return (
    <HealthRepositoryProvider repository={repository}>
      {children}
    </HealthRepositoryProvider>
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
      <HealthRepositoryProvider repository={repository}>
        {children}
      </HealthRepositoryProvider>
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

export function useHealthDataVersion(scope: Exclude<HealthRefreshScope, 'all'>) {
  switch (scope) {
    case 'dashboard':
      return useContext(DashboardVersionContext);
    case 'sleep':
      return useContext(SleepVersionContext);
    case 'heart':
      return useContext(HeartVersionContext);
    case 'wellness':
      return useContext(WellnessVersionContext);
    case 'trends':
      return useContext(TrendsVersionContext);
    case 'derived':
      return useContext(DerivedVersionContext);
  }
}

export function useRefreshHealthData() {
  const refresh = useContext(HealthRefreshContext);

  if (!refresh) {
    throw new Error('Health repository is not available.');
  }

  return refresh;
}
