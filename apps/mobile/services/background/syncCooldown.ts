import AsyncStorage from '@react-native-async-storage/async-storage';

const SYNC_RECENT_START_COOLDOWN_MS = 2 * 60 * 1000;
const SYNC_SUCCESS_COOLDOWN_MS = 10 * 60 * 1000;
const LAST_STARTED_KEY = '@unstrap/wearable-sync/last-started';
const LAST_SUCCESS_KEY = '@unstrap/wearable-sync/last-success';
let syncStartReservationQueue = Promise.resolve();

export type SyncCooldownSkipReason = 'sync-started-cooldown' | 'sync-success-cooldown';

export interface SyncCooldownSkip {
  reason: SyncCooldownSkipReason;
}

function parseStoredTimestamp(value: string | null) {
  if (!value) {
    return null;
  }

  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

async function readTimestamp(key: string) {
  return parseStoredTimestamp(await AsyncStorage.getItem(key).catch(() => null));
}

async function writeTimestamp(key: string, timestamp: number) {
  await AsyncStorage.setItem(key, String(timestamp)).catch(() => {});
}

export async function resolveSyncCooldown(nowMs = Date.now()): Promise<SyncCooldownSkip | null> {
  const [lastSuccessfulSyncAtMs, lastSyncStartedAtMs] = await Promise.all([
    readTimestamp(LAST_SUCCESS_KEY),
    readTimestamp(LAST_STARTED_KEY),
  ]);

  if (lastSuccessfulSyncAtMs !== null && nowMs - lastSuccessfulSyncAtMs < SYNC_SUCCESS_COOLDOWN_MS) {
    return { reason: 'sync-success-cooldown' };
  }

  if (lastSyncStartedAtMs !== null && nowMs - lastSyncStartedAtMs < SYNC_RECENT_START_COOLDOWN_MS) {
    return { reason: 'sync-started-cooldown' };
  }

  return null;
}

export async function recordSyncCooldownStarted(nowMs = Date.now()) {
  await writeTimestamp(LAST_STARTED_KEY, nowMs);
}

export async function recordSyncCooldownSuccess(nowMs = Date.now()) {
  await writeTimestamp(LAST_SUCCESS_KEY, nowMs);
}

export async function reserveSyncCooldownStart(nowMs = Date.now()): Promise<SyncCooldownSkip | null> {
  const reservation = syncStartReservationQueue
    .catch(() => {})
    .then(async () => {
      const skip = await resolveSyncCooldown(nowMs);
      if (skip) {
        return skip;
      }

      await recordSyncCooldownStarted(nowMs);
      return null;
    });

  syncStartReservationQueue = reservation.then(() => undefined, () => undefined);
  return reservation;
}
