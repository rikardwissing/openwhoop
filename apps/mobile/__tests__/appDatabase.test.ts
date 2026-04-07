const mockOpenDatabaseAsync = jest.fn(async () => ({}));
const mockDeleteDatabaseAsync = jest.fn(async () => {});
const mockImportDatabaseFromAssetAsync = jest.fn(async () => {});

jest.mock('expo-sqlite', () => ({
  __esModule: true,
  openDatabaseAsync: mockOpenDatabaseAsync,
  deleteDatabaseAsync: mockDeleteDatabaseAsync,
  importDatabaseFromAssetAsync: mockImportDatabaseFromAssetAsync,
}));

const { clearLocalAppDatabaseAsync, seedBundledAppDatabaseAsync } = require('@/db/appDatabase');
const { APP_DATABASE_NAME } = require('@/db/schema');

describe('appDatabase helpers', () => {
  beforeEach(() => {
    mockOpenDatabaseAsync.mockClear();
    mockDeleteDatabaseAsync.mockClear();
    mockImportDatabaseFromAssetAsync.mockClear();
  });

  it('clears the local database without importing a bundled asset', async () => {
    const closeAsync = jest.fn(async () => {});

    await clearLocalAppDatabaseAsync({ closeAsync } as never);

    expect(closeAsync).toHaveBeenCalledTimes(1);
    expect(mockDeleteDatabaseAsync).toHaveBeenCalledWith(APP_DATABASE_NAME);
    expect(mockImportDatabaseFromAssetAsync).not.toHaveBeenCalled();
  });

  it('replaces the local database with the bundled asset database', async () => {
    const closeAsync = jest.fn(async () => {});

    await seedBundledAppDatabaseAsync({ closeAsync } as never);

    expect(closeAsync).toHaveBeenCalledTimes(1);
    expect(mockDeleteDatabaseAsync).toHaveBeenCalledWith(APP_DATABASE_NAME);
    expect(mockImportDatabaseFromAssetAsync).toHaveBeenCalledWith(
      APP_DATABASE_NAME,
      expect.objectContaining({
        assetId: expect.anything(),
        forceOverwrite: true,
      }),
    );
  });

  it('can import the bundled asset without an existing database connection', async () => {
    await seedBundledAppDatabaseAsync();

    expect(mockDeleteDatabaseAsync).toHaveBeenCalledWith(APP_DATABASE_NAME);
    expect(mockImportDatabaseFromAssetAsync).toHaveBeenCalledTimes(1);
  });
});