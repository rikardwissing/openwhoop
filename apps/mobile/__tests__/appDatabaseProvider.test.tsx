import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';
import { useEffect, useState } from 'react';

const mockSeedBundledAppDatabaseAsync = jest.fn(async (_currentDb?: unknown) => {});
const mockClearLocalAppDatabaseAsync = jest.fn(async (_currentDb?: unknown) => {});

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
    expect(screen.getByTestId('database-id').props.children).toBe('1');

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
});