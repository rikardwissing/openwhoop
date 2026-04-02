import { HistorySyncWatchdog, SYNC_PACKET_INACTIVITY_TIMEOUT_MS, SYNC_PROGRESS_TIMEOUT_MS } from '@/services/ble/syncWatchdog';

describe('HistorySyncWatchdog', () => {
  const snapshot = {
    importedReadings: 128,
    lastHistoryCursor: 1_735_689_600_000,
  };

  it('does not fail while packets and progress are recent', () => {
    const watchdog = new HistorySyncWatchdog();
    watchdog.markPacketActivity(5_000);
    watchdog.markProgress(5_000);

    expect(watchdog.getTimeoutError(snapshot, 5_000 + SYNC_PACKET_INACTIVITY_TIMEOUT_MS - 1)).toBeNull();
    watchdog.markPacketActivity(5_000 + SYNC_PROGRESS_TIMEOUT_MS - 1);
    expect(watchdog.getTimeoutError(snapshot, 5_000 + SYNC_PROGRESS_TIMEOUT_MS - 1)).toBeNull();
  });

  it('fails when packet activity stops entirely', () => {
    const watchdog = new HistorySyncWatchdog();
    watchdog.markPacketActivity(10_000);
    watchdog.markProgress(10_000);

    expect(
      watchdog.getTimeoutError(snapshot, 10_000 + SYNC_PACKET_INACTIVITY_TIMEOUT_MS + 1)?.message,
    ).toBe(`History sync stalled after ${snapshot.importedReadings} readings. Last cursor ${snapshot.lastHistoryCursor}.`);
  });

  it('fails when packets arrive but history stops progressing', () => {
    const watchdog = new HistorySyncWatchdog();
    watchdog.markProgress(20_000);
    watchdog.markPacketActivity(20_000 + SYNC_PROGRESS_TIMEOUT_MS + 5_000);

    expect(
      watchdog.getTimeoutError(snapshot, 20_000 + SYNC_PROGRESS_TIMEOUT_MS + 5_000)?.message,
    ).toBe(`History sync stopped making progress after ${snapshot.importedReadings} readings. Last cursor ${snapshot.lastHistoryCursor}.`);
  });

  it('uses a pre-history message when packets arrive without history data', () => {
    const watchdog = new HistorySyncWatchdog();
    watchdog.markProgress(0);
    watchdog.markPacketActivity(SYNC_PROGRESS_TIMEOUT_MS + 5_000);

    expect(
      watchdog.getTimeoutError(
        { importedReadings: 0, lastHistoryCursor: 0 },
        SYNC_PROGRESS_TIMEOUT_MS + 5_000,
      )?.message,
    ).toBe('History sync did not begin sending history data.');
  });
});
