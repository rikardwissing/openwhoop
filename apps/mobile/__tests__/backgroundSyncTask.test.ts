const mockRegisterTaskAsync = jest.fn<Promise<void>, [string, object?]>(async () => {});
const mockUnregisterTaskAsync = jest.fn<Promise<void>, [string]>(async () => {});
const mockGetStatusAsync = jest.fn<Promise<number>, []>(async () => 2);
const mockTriggerTaskWorkerForTestingAsync = jest.fn<Promise<boolean>, []>(async () => true);
const mockIsTaskDefined = jest.fn<boolean, [string]>(() => true);
const mockIsTaskRegisteredAsync = jest.fn<Promise<boolean>, [string]>(async () => true);
const mockDb = {
  closeAsync: jest.fn(async () => {}),
};
const mockOpenAppDatabaseAsync = jest.fn<Promise<typeof mockDb>, []>(async () => mockDb);
const mockSetBackgroundSyncPairedDevice = jest.fn<Promise<void>, [unknown, string | null]>(async () => {});
const mockGetBackgroundSyncState = jest.fn<Promise<{
  pairedDeviceId: null;
  lastRunStartedAt: null;
  lastRunFinishedAt: null;
  lastSuccessAt: null;
  lastSource: null;
  lastResult: null;
  lastError: null;
  lastImportedReadings: null;
  notificationPermission: 'unknown';
  notificationBaselineAt: null;
}>, [unknown]>(async () => ({
  pairedDeviceId: null,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  lastSuccessAt: null,
  lastSource: null,
  lastResult: null,
  lastError: null,
  lastImportedReadings: null,
  notificationPermission: 'unknown',
  notificationBaselineAt: null,
}));
const mockUpdateNotificationPermissionState = jest.fn<Promise<void>, [unknown, unknown]>(async () => {});
const mockSetNotificationHandler = jest.fn<void, [object]>();
const mockGetPermissionsAsync = jest.fn<Promise<{
  granted: false;
  canAskAgain: true;
  ios: {
    status: number;
  };
}>, []>(async () => ({
  granted: false,
  canAskAgain: true,
  ios: {
    status: 0,
  },
}));

jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
  },
}));

jest.mock('expo-background-task', () => ({
  BackgroundTaskStatus: {
    Restricted: 1,
    Available: 2,
  },
  BackgroundTaskResult: {
    Success: 1,
    Failed: 2,
  },
  registerTaskAsync: (taskName: string, options?: object) => mockRegisterTaskAsync(taskName, options),
  unregisterTaskAsync: (taskName: string) => mockUnregisterTaskAsync(taskName),
  getStatusAsync: () => mockGetStatusAsync(),
  triggerTaskWorkerForTestingAsync: () => mockTriggerTaskWorkerForTestingAsync(),
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskDefined: (taskName: string) => mockIsTaskDefined(taskName),
  isTaskRegisteredAsync: (taskName: string) => mockIsTaskRegisteredAsync(taskName),
}));

jest.mock('expo-notifications', () => ({
  IosAuthorizationStatus: {
    PROVISIONAL: 1,
  },
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: () => mockGetPermissionsAsync(),
  requestPermissionsAsync: jest.fn(),
}));

jest.mock('@/db/appDatabase', () => ({
  openAppDatabaseAsync: () => mockOpenAppDatabaseAsync(),
}));

jest.mock('@/services/background/backgroundSyncNotifications', () => ({
  deliverBackgroundSyncRunNotification: jest.fn(async () => false),
  deliverNewBackgroundNotifications: jest.fn(async () => 0),
}));

jest.mock('@/data/sqlite/SQLiteHealthRepository', () => ({
  processPendingDerivedRefresh: jest.fn(async () => true),
  refreshDashboardSnapshot: jest.fn(async () => true),
}));

jest.mock('@/services/background/backgroundSyncState', () => ({
  clearBackgroundSyncState: jest.fn(async () => {}),
  getBackgroundSyncState: (db: unknown) => mockGetBackgroundSyncState(db),
  recordBackgroundRunResult: jest.fn(async () => {}),
  recordBackgroundRunStart: jest.fn(async () => {}),
  setBackgroundSyncPairedDevice: (db: unknown, deviceId: string | null) => mockSetBackgroundSyncPairedDevice(db, deviceId),
  updateNotificationPermissionState: (db: unknown, permission: unknown) => mockUpdateNotificationPermissionState(db, permission),
}));

jest.mock('@/services/ble/WearableSyncService', () => ({
  WearableSyncService: jest.fn().mockImplementation(() => ({
    getDeviceState: jest.fn(async () => ({ id: null })),
    syncInBackground: jest.fn(async () => ({
      status: 'success',
      importedReadings: 0,
      completedAt: '2026-04-02 10:00:00',
    })),
    dispose: jest.fn(async () => {}),
  })),
}));

jest.mock('@/utils/dateTime', () => ({
  formatSqliteDateTime: jest.fn(() => '2026-04-02 10:00:00'),
}));

import {
  BACKGROUND_SYNC_MIN_INTERVAL_MINUTES,
  BACKGROUND_SYNC_TASK_NAME,
  ensureBackgroundSyncRegistered,
  getBackgroundSyncDiagnostics,
  triggerBackgroundSyncForTesting,
} from '@/services/background/backgroundSyncTask';

describe('background sync task diagnostics', () => {
  beforeEach(() => {
    mockRegisterTaskAsync.mockClear();
    mockUnregisterTaskAsync.mockClear();
    mockGetStatusAsync.mockClear();
    mockTriggerTaskWorkerForTestingAsync.mockClear();
    mockIsTaskDefined.mockClear();
    mockIsTaskRegisteredAsync.mockClear();
    mockOpenAppDatabaseAsync.mockClear();
    mockSetBackgroundSyncPairedDevice.mockClear();
    mockGetBackgroundSyncState.mockClear();
    mockUpdateNotificationPermissionState.mockClear();
    mockGetPermissionsAsync.mockClear();
    mockIsTaskDefined.mockReturnValue(true);
    mockIsTaskRegisteredAsync.mockResolvedValue(true);
    mockGetStatusAsync.mockResolvedValue(2);
  });

  it('reports the current background sync diagnostics', async () => {
    const diagnostics = await getBackgroundSyncDiagnostics();

    expect(diagnostics).toEqual({
      apiStatus: 'available',
      isTaskDefined: true,
      isTaskRegistered: true,
      minimumIntervalMinutes: 15,
    });
  });

  it('registers the iOS background task with the supported minimum interval', async () => {
    await ensureBackgroundSyncRegistered('strap-1');

    expect(BACKGROUND_SYNC_MIN_INTERVAL_MINUTES).toBe(15);
    expect(mockRegisterTaskAsync).toHaveBeenCalledWith(BACKGROUND_SYNC_TASK_NAME, {
      minimumInterval: 15,
    });
  });

  it('uses Expo test triggering in development', async () => {
    const triggered = await triggerBackgroundSyncForTesting();

    expect(triggered).toBe(true);
    expect(mockTriggerTaskWorkerForTestingAsync).toHaveBeenCalledTimes(1);
  });
});
