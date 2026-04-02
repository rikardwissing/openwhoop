export const SYNC_PACKET_INACTIVITY_TIMEOUT_MS = 12_000;
export const SYNC_PROGRESS_TIMEOUT_MS = 60_000;

export interface HistorySyncSnapshot {
  importedReadings: number;
  lastHistoryCursor: number;
}

export class HistorySyncWatchdog {
  private lastPacketAt = Date.now();
  private lastProgressAt = Date.now();

  markPacketActivity(now = Date.now()) {
    this.lastPacketAt = now;
  }

  markProgress(now = Date.now()) {
    this.lastProgressAt = now;
  }

  getTimeoutError(snapshot: HistorySyncSnapshot, now = Date.now()) {
    if (now - this.lastPacketAt > SYNC_PACKET_INACTIVITY_TIMEOUT_MS) {
      return new Error(
        snapshot.importedReadings > 0
          ? `History sync stalled after ${snapshot.importedReadings} readings. Last cursor ${snapshot.lastHistoryCursor}.`
          : 'History sync stalled before the wearable sent any readings.',
      );
    }

    if (now - this.lastProgressAt > SYNC_PROGRESS_TIMEOUT_MS) {
      return new Error(
        snapshot.importedReadings > 0
          ? `History sync stopped making progress after ${snapshot.importedReadings} readings. Last cursor ${snapshot.lastHistoryCursor}.`
          : 'History sync did not begin sending history data.',
      );
    }

    return null;
  }
}
