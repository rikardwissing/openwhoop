import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';
import { useEffect, useState } from 'react';

const mockSeedBundledAppDatabaseAsync = jest.fn(async (_currentDb?: unknown) => {});
const mockClearLocalAppDatabaseAsync = jest.fn(async (_currentDb?: unknown) => {});
const mockInspectRequiredStartupMigration = jest.fn(async (_db?: unknown) => ({
  heartRateHasImuColumn: false,
  pendingSensorDataBackfillRows: 0,
  needsMigration: false,
}));
const mockRunRequiredStartupMigration = jest.fn(async (_db?: unknown, _options?: unknown) => ({
  ran: false,
  migratedLegacyHeartRate: false,
  backfilledSensorDataRows: 0,
}));

let mockNextDatabaseId = 0;
let mockBlockNextDatabaseMount = false;
let mockReleaseBlockedDatabaseMount: (() => void) | null = null;
let mockLastProviderOptions: { useNewConnection?: boolean } | undefined;
let mockLastUseSuspense: boolean | undefined;

jest.mock('expo-sqlite', () => {
  const React = require('react');
  const SQLiteContext = React.createContext(null);

  return {
    SQLiteProvider: ({
      children,
      options,
      useSuspense,
    }: {
      children: React.ReactNode;
      options?: { useNewConnection?: boolean };
      useSuspense?: boolean;
    }) => {
      mockLastProviderOptions = options;
      mockLastUseSuspense = useSuspense;
      const [database] = React.useState(() => ({
        id: ++mockNextDatabaseId,
        closeAsync: jest.fn(async () => {}),
      }));
      const [ready, setReady] = React.useState(() => !mockBlockNextDatabaseMount);

      React.useEffect(() => {
        if (ready) {
          return undefined;
        }

        const release = () => {
          mockBlockNextDatabaseMount = false;
          setReady(true);
        };

        mockReleaseBlockedDatabaseMount = release;

        return () => {
          if (mockReleaseBlockedDatabaseMount === release) {
            mockReleaseBlockedDatabaseMount = null;
          }
        };
      }, [ready]);

      if (!ready) {
        return null;
      }

      return <SQLiteContext.Provider value={database}>{children}</SQLiteContext.Provider>;
    },
    useSQLiteContext: () => React.useContext(SQLiteContext),
  };
});

jest.mock('@/db/appDatabase', () => ({
  clearLocalAppDatabaseAsync: (currentDb?: unknown) => mockClearLocalAppDatabaseAsync(currentDb),
  seedBundledAppDatabaseAsync: (currentDb?: unknown) => mockSeedBundledAppDatabaseAsync(currentDb),
}));

jest.mock('@/db/maintenance', () => ({
  inspectRequiredStartupMigration: (db: unknown) => mockInspectRequiredStartupMigration(db),
  runRequiredStartupMigration: (db: unknown, options?: unknown) => mockRunRequiredStartupMigration(db, options),
}));

jest.mock('@/db/schema', () => ({
  APP_DATABASE_NAME: 'btwearable.db',
  initializeDatabase: jest.fn(async () => {}),
}));

import {
  AppDatabaseProvider,
  useAppDatabaseControls,
  useOptionalAppDatabase,
} from '@/providers/AppDatabaseProvider';

function createDeferredPromise() {
  let resolvePromise: (() => void) | null = null;

  return {
    promise: new Promise<void>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve() {
      resolvePromise?.();
    },
  };
}

function SeededDataHarness({
  onDatabaseIdChange,
  onSeedStatusChange,
}: {
  onDatabaseIdChange: (value: string) => void;
  onSeedStatusChange: (value: 'idle' | 'running' | 'complete') => void;
}) {
  const database = useOptionalAppDatabase();
  const { loadSeededData } = useAppDatabaseControls();

  useEffect(() => {
    onDatabaseIdChange(String((database as { id: number } | null)?.id ?? 'none'));

    return () => {
      onDatabaseIdChange('none');
    };
  }, [database, onDatabaseIdChange]);

  return (
    <Pressable
      testID="enable-seeded-data"
      onPress={() => {
        onSeedStatusChange('running');
        void loadSeededData().then(() => {
          onSeedStatusChange('complete');
        });
      }}
    />
  );
}

function SeededDataTestShell() {
  const [databaseId, setDatabaseId] = useState('none');
  const [seedStatus, setSeedStatus] = useState<'idle' | 'running' | 'complete'>('idle');

  return (
    <View>
      <Text testID="database-id">{databaseId}</Text>
      <Text testID="seed-status">{seedStatus}</Text>
      <AppDatabaseProvider>
        <SeededDataHarness
          onDatabaseIdChange={setDatabaseId}
          onSeedStatusChange={setSeedStatus}
        />
      </AppDatabaseProvider>
    </View>
  );
}

describe('AppDatabaseProvider', () => {
  beforeEach(() => {
    mockSeedBundledAppDatabaseAsync.mockClear();
    mockClearLocalAppDatabaseAsync.mockClear();
    mockInspectRequiredStartupMigration.mockClear();
    mockRunRequiredStartupMigration.mockClear();
    mockInspectRequiredStartupMigration.mockImplementation(async (_db?: unknown) => ({
      heartRateHasImuColumn: false,
      pendingSensorDataBackfillRows: 0,
      needsMigration: false,
    }));
    mockRunRequiredStartupMigration.mockImplementation(async (_db?: unknown) => ({
      ran: false,
      migratedLegacyHeartRate: false,
      backfilledSensorDataRows: 0,
    }));
    mockNextDatabaseId = 0;
    mockBlockNextDatabaseMount = false;
    mockReleaseBlockedDatabaseMount = null;
    mockLastProviderOptions = undefined;
    mockLastUseSuspense = undefined;
  });

  it('waits for the replacement database to mount before seeded-data loading resolves', async () => {
    const deferredSeed = createDeferredPromise();
    mockSeedBundledAppDatabaseAsync.mockImplementationOnce(() => deferredSeed.promise);

    const screen = render(<SeededDataTestShell />);

    expect(mockLastProviderOptions).toEqual({ useNewConnection: true });
    expect(mockLastUseSuspense).toBeUndefined();

    await waitFor(() => {
      expect(screen.getByTestId('database-id').props.children).toBe('1');
    });

    mockBlockNextDatabaseMount = true;

    fireEvent.press(screen.getByTestId('enable-seeded-data'));

    await waitFor(() => {
      expect(screen.getByTestId('database-id').props.children).toBe('none');
      expect(mockSeedBundledAppDatabaseAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
        }),
      );
    });

    expect(screen.getByTestId('seed-status').props.children).toBe('running');

    await act(async () => {
      deferredSeed.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('seed-status').props.children).toBe('running');
    expect(screen.getByTestId('database-id').props.children).toBe('none');

    act(() => {
      mockReleaseBlockedDatabaseMount?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId('database-id').props.children).toBe('2');
      expect(screen.getByTestId('seed-status').props.children).toBe('complete');
    });
  });

  it('shows a visible startup status screen while migration requirements are being inspected', async () => {
    const deferredInspection = createDeferredPromise();
    mockInspectRequiredStartupMigration.mockImplementationOnce(async (_db?: unknown) => {
      await deferredInspection.promise;
      return {
        heartRateHasImuColumn: false,
        pendingSensorDataBackfillRows: 0,
        needsMigration: false,
      };
    });

    const screen = render(<SeededDataTestShell />);

    await waitFor(() => {
      expect(screen.getByText('Preparing local data')).toBeTruthy();
      expect(screen.getByText('Checking your saved data before the app starts.')).toBeTruthy();
    });

    expect(screen.getByTestId('database-id').props.children).toBe('none');

    await act(async () => {
      deferredInspection.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('database-id').props.children).toBe('1');
    });
  });

  it('blocks children behind the migration screen until startup migration completes', async () => {
    const deferredMigration = createDeferredPromise();
    mockInspectRequiredStartupMigration.mockImplementationOnce(async (_db?: unknown) => ({
      heartRateHasImuColumn: false,
      pendingSensorDataBackfillRows: 3,
      needsMigration: true,
    }));
    mockRunRequiredStartupMigration.mockImplementationOnce(
      async (_db?: unknown, options?: unknown) => {
        const progressOptions = options as
          | {
              onProgress?: (progress: {
                stage: 'legacy_heart_rate' | 'sensor_data_backfill' | 'complete';
                completedUnits: number;
                totalUnits: number;
                backfilledSensorDataRows: number;
                totalSensorDataRows: number;
              }) => void;
            }
          | undefined;

        progressOptions?.onProgress?.({
          stage: 'sensor_data_backfill',
          completedUnits: 1,
          totalUnits: 3,
          backfilledSensorDataRows: 1,
          totalSensorDataRows: 3,
        });
        await deferredMigration.promise;
        return {
          ran: true,
          migratedLegacyHeartRate: false,
          backfilledSensorDataRows: 3,
        };
      },
    );

    const screen = render(<SeededDataTestShell />);

    await waitFor(() => {
      expect(screen.getByText('Migrating local data')).toBeTruthy();
      expect(screen.getByText('1 / 3 samples updated')).toBeTruthy();
    });

    expect(screen.getByTestId('database-id').props.children).toBe('none');
    expect(mockRunRequiredStartupMigration).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      expect.any(Object),
    );

    await act(async () => {
      deferredMigration.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('database-id').props.children).toBe('1');
    });
  });
});