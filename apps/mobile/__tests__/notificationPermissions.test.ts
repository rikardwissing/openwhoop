const mockDb = {
  closeAsync: jest.fn(async () => {}),
};

type MockSyncState = {
  pairedDeviceId: null;
  lastRunStartedAt: null;
  lastRunFinishedAt: null;
  lastSuccessAt: null;
  lastSource: null;
  lastResult: null;
  lastError: null;
  lastImportedReadings: null;
  notificationPermission: 'unknown' | 'granted' | 'provisional' | 'denied';
  notificationBaselineAt: string | null;
  lastSyncImportSummary: null;
};

type MockPermissionStatus = {
  granted: boolean;
  canAskAgain: boolean;
  ios: {
    status: number;
  };
};

const mockOpenAppDatabaseAsync = jest.fn(async () => mockDb);
const mockGetBackgroundSyncState = jest.fn<Promise<MockSyncState>, [unknown]>(async () => ({
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
  lastSyncImportSummary: null,
}));
const mockUpdateNotificationPermissionState = jest.fn<Promise<void>, [unknown, unknown, unknown]>(async () => {});
const mockGetPermissionsAsync = jest.fn<Promise<MockPermissionStatus>, []>(async () => ({
  granted: false,
  canAskAgain: true,
  ios: {
    status: 0,
  },
}));
const mockRequestPermissionsAsync = jest.fn<Promise<MockPermissionStatus>, [unknown]>(async () => ({
  granted: true,
  canAskAgain: true,
  ios: {
    status: 0,
  },
}));

jest.mock('expo-notifications', () => ({
  IosAuthorizationStatus: {
    PROVISIONAL: 1,
  },
  getPermissionsAsync: () => mockGetPermissionsAsync(),
  requestPermissionsAsync: (options: unknown) => mockRequestPermissionsAsync(options),
}));

jest.mock('@/db/appDatabase', () => ({
  openAppDatabaseAsync: () => mockOpenAppDatabaseAsync(),
}));

jest.mock('@/services/background/backgroundSyncState', () => ({
  getBackgroundSyncState: (db: unknown) => mockGetBackgroundSyncState(db),
  updateNotificationPermissionState: (db: unknown, permission: unknown, baselineAt: unknown) =>
    mockUpdateNotificationPermissionState(db, permission, baselineAt),
}));

jest.mock('@/utils/dateTime', () => ({
  formatSqliteDateTime: jest.fn(() => '2026-04-02 10:00:00'),
}));

import { syncNotificationPermissionFromSystem } from '@/services/notifications/notificationPermissions';

describe('notification permissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenAppDatabaseAsync.mockResolvedValue(mockDb);
    mockGetBackgroundSyncState.mockResolvedValue({
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
      lastSyncImportSummary: null,
    });
    mockGetPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
      ios: {
        status: 0,
      },
    });
    mockRequestPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
      ios: {
        status: 0,
      },
    });
  });

  it('requests notification access and stores the new baseline when permission is gained', async () => {
    await expect(syncNotificationPermissionFromSystem(true)).resolves.toEqual({
      permission: 'granted',
      baselineAt: '2026-04-02 10:00:00',
    });

    expect(mockRequestPermissionsAsync).toHaveBeenCalledWith({
      ios: {
        allowAlert: true,
        allowBadge: false,
        allowSound: true,
      },
    });
    expect(mockUpdateNotificationPermissionState).toHaveBeenCalledWith(
      mockDb,
      'granted',
      '2026-04-02 10:00:00',
    );
    expect(mockDb.closeAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing baseline when permission was already granted earlier', async () => {
    mockGetBackgroundSyncState.mockResolvedValueOnce({
      pairedDeviceId: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastSuccessAt: null,
      lastSource: null,
      lastResult: null,
      lastError: null,
      lastImportedReadings: null,
      notificationPermission: 'granted',
      notificationBaselineAt: '2026-04-01 09:00:00',
      lastSyncImportSummary: null,
    });
    mockGetPermissionsAsync.mockResolvedValueOnce({
      granted: true,
      canAskAgain: true,
      ios: {
        status: 0,
      },
    });

    await expect(syncNotificationPermissionFromSystem(false)).resolves.toEqual({
      permission: 'granted',
      baselineAt: '2026-04-01 09:00:00',
    });

    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockUpdateNotificationPermissionState).toHaveBeenCalledWith(
      mockDb,
      'granted',
      '2026-04-01 09:00:00',
    );
  });
});