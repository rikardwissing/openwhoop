import { createContext, useContext, useState, type ReactNode } from 'react';

import type { HealthRepository } from '@/data/HealthRepository';
import { MockHealthRepository } from '@/data/mock/MockHealthRepository';

const HealthRepositoryContext = createContext<HealthRepository | null>(null);

export function HealthDataProvider({
  children,
  repository,
}: {
  children: ReactNode;
  repository?: HealthRepository;
}) {
  const [value] = useState<HealthRepository>(() => repository ?? new MockHealthRepository());

  return (
    <HealthRepositoryContext.Provider value={value}>
      {children}
    </HealthRepositoryContext.Provider>
  );
}

export function useHealthRepository() {
  const repository = useContext(HealthRepositoryContext);

  if (!repository) {
    throw new Error('Health repository is not available.');
  }

  return repository;
}
