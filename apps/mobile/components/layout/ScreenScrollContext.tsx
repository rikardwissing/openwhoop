import { createContext, useContext } from 'react';

export type AcquireScreenScrollLock = () => () => void;

export const ScreenScrollContext = createContext<AcquireScreenScrollLock | null>(null);

export function useAcquireScreenScrollLock() {
  return useContext(ScreenScrollContext);
}