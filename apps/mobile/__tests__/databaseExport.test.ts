const mockCreate = jest.fn();
const mockWrite = jest.fn();
const mockIsAvailableAsync = jest.fn(async () => true);
const mockShareAsync = jest.fn(async () => {});

jest.mock('expo-file-system', () => ({
  __esModule: true,
  File: class {
    name = 'btwearable.db';
    uri = 'file:///mock-cache/exports/btwearable.db';

    constructor(..._args: unknown[]) {}

    create(options: unknown) {
      mockCreate(options);
    }

    write(value: Uint8Array) {
      mockWrite(value);
    }
  },
  Paths: {
    cache: 'file:///mock-cache',
  },
}));

jest.mock('expo-sharing', () => ({
  __esModule: true,
  isAvailableAsync: () => mockIsAvailableAsync(),
  shareAsync: (...args: Parameters<typeof mockShareAsync>) => mockShareAsync(...args),
}));

import { exportAndShareDatabaseSnapshot } from '@/services/databaseExport';

describe('databaseExport', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockWrite.mockClear();
    mockIsAvailableAsync.mockClear();
    mockShareAsync.mockClear();
  });

  it('shares the current local database snapshot without triggering maintenance', async () => {
    const serializedDatabase = Uint8Array.from([1, 2, 3, 4]);
    const db = {
      serializeAsync: jest.fn(async () => serializedDatabase),
    };

    const result = await exportAndShareDatabaseSnapshot(db as never);

    expect(db.serializeAsync).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      intermediates: true,
      overwrite: true,
    });
    expect(mockWrite).toHaveBeenCalledWith(serializedDatabase);
    expect(mockShareAsync).toHaveBeenCalledWith('file:///mock-cache/exports/btwearable.db', {
      dialogTitle: 'Export Unstrap data snapshot',
    });
    expect(result).toMatchObject({
      fileName: 'btwearable.db',
      fileUri: 'file:///mock-cache/exports/btwearable.db',
      sizeBytes: 4,
    });
  });
});