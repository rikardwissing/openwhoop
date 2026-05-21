import type { SQLiteDatabase } from 'expo-sqlite';

const DATABASE_LOCK_RETRY_DELAYS_MS = [80, 160, 320, 640, 1000];
const resilientDatabaseProxies = new WeakMap<SQLiteDatabase, SQLiteDatabase>();
const databaseWriteQueues = new Map<string, Promise<unknown>>();

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isDatabaseLockedError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('database is locked') ||
    message.includes('database locked') ||
    message.includes('database is busy') ||
    message.includes('database busy') ||
    message.includes('sqlite_busy') ||
    message.includes('sqlite_locked')
  );
}

export async function withDatabaseRetry<T>(
  task: () => Promise<T>,
  delaysMs = DATABASE_LOCK_RETRY_DELAYS_MS,
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await task();
    } catch (error) {
      if (!isDatabaseLockedError(error) || attempt >= delaysMs.length) {
        throw error;
      }

      await delay(delaysMs[attempt]);
      attempt += 1;
    }
  }
}

function databaseQueueKey(db: SQLiteDatabase) {
  return db.databasePath ?? 'default';
}

async function enqueueDatabaseWrite<T>(db: SQLiteDatabase, task: () => Promise<T>): Promise<T> {
  const key = databaseQueueKey(db);
  const previous = databaseWriteQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);

  databaseWriteQueues.set(
    key,
    next.catch(() => {}),
  );

  return next;
}

async function waitForDatabaseWrites(db: SQLiteDatabase) {
  await (databaseWriteQueues.get(databaseQueueKey(db)) ?? Promise.resolve()).catch(() => {});
}

function isPreparedRead(source: string) {
  const normalized = source.trimStart().toLowerCase();
  return (
    normalized.startsWith('select') ||
    normalized.startsWith('with') ||
    normalized.startsWith('explain')
  );
}

function wrapPreparedStatement<T extends object>(
  statement: T,
  source: string,
  db: SQLiteDatabase,
  serializeWrites: boolean,
): T {
  return new Proxy(statement, {
    get(target, prop, receiver) {
      if (prop === 'executeAsync' || prop === 'executeForRawResultAsync') {
        const execute = Reflect.get(target, prop, receiver);
        if (typeof execute !== 'function') {
          return execute;
        }

        return (...args: unknown[]) => {
          const task = () => withDatabaseRetry(() => execute.apply(target, args));
          return serializeWrites && !isPreparedRead(source)
            ? enqueueDatabaseWrite(db, task)
            : task();
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function createResilientDatabaseProxy(
  db: SQLiteDatabase,
  options: {
    cacheProxy: boolean;
    serializeWrites: boolean;
  },
): SQLiteDatabase {
  if (options.cacheProxy) {
    const existing = resilientDatabaseProxies.get(db);
    if (existing) {
      return existing;
    }
  }

  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'runAsync' || prop === 'execAsync') {
        const run = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) => {
          const task = () => withDatabaseRetry(() => run.apply(target, args));
          return options.serializeWrites ? enqueueDatabaseWrite(target, task) : task();
        };
      }

      if (prop === 'getAllAsync' || prop === 'getFirstAsync') {
        const read = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) => withDatabaseRetry(() => read.apply(target, args));
      }

      if (prop === 'prepareAsync') {
        return async (source: string) => {
          const statement = await withDatabaseRetry(() => target.prepareAsync(source));
          return wrapPreparedStatement(statement, source, target, options.serializeWrites);
        };
      }

      if (prop === 'withExclusiveTransactionAsync') {
        return (task: (tx: SQLiteDatabase) => Promise<void>) =>
          enqueueDatabaseWrite(target, () =>
            withDatabaseRetry(() =>
              target.withExclusiveTransactionAsync((tx) =>
                task(createResilientDatabaseProxy(tx as SQLiteDatabase, {
                  cacheProxy: false,
                  serializeWrites: false,
                })),
              ),
            ),
          );
      }

      if (prop === 'closeAsync') {
        return async () => {
          await waitForDatabaseWrites(target);
          return withDatabaseRetry(() => target.closeAsync());
        };
      }

      if (prop === 'serializeAsync') {
        const serialize = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          await waitForDatabaseWrites(target);
          return withDatabaseRetry(() => serialize.apply(target, args));
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  if (options.cacheProxy) {
    resilientDatabaseProxies.set(db, proxy);
  }

  return proxy;
}

export function createResilientDatabase(db: SQLiteDatabase): SQLiteDatabase {
  return createResilientDatabaseProxy(db, {
    cacheProxy: true,
    serializeWrites: true,
  });
}
