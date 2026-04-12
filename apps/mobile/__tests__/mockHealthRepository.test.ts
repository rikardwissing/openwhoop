import { MockHealthRepository } from '@/data/mock/MockHealthRepository';

describe('MockHealthRepository', () => {
  it('returns seeded today, history, and wellness data', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });

    const todayOverview = await repository.getTodayOverview();
    const latestHistoryOverview = await repository.getHistoryOverview(todayOverview.day.dayKey);
    const historyOverview = await repository.getHistoryOverview('2026-04-23');
    const heart = await repository.getHeartHistory('14d');
    const wellness = await repository.getWellnessData('14d');

    expect(todayOverview.recovery.score).toBe(64);
    expect(latestHistoryOverview.heartCard.series.length).toBe(288);
    expect(latestHistoryOverview.heartCard.markers).toHaveLength(4);
    expect(latestHistoryOverview.heartCard.markers.some((marker) => marker.id === 'activity-tempo-run')).toBe(true);
    expect(historyOverview.heartCard.series.length).toBe(288);
    expect(todayOverview.activitySummary).toHaveLength(3);
    expect(todayOverview.insights.length).toBeGreaterThan(0);
    expect(heart.intraday.length).toBe(288);
    expect(heart.intradayMarkers).toHaveLength(4);
    expect(heart.intradayMarkers[0]?.kind).toBe('sleep');
    expect(heart.intraday[1]?.label).toBe('12:05 AM');
    expect(wellness.activities).toHaveLength(3);
    expect(wellness.skinTemperature.hasPartialData).toBe(true);
  });

  it('expands dashboard heart timelines by requested range without changing the intraday card contract', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });

    const timeline24h = await repository.getDashboardHeartTimeline('24h');
    const timeline7d = await repository.getDashboardHeartTimeline('7d');
    const timeline7dZoomed = await repository.getDashboardHeartTimeline('7d', { bucketMinutes: 1 });

    expect(timeline24h.series.length).toBe((24 * 60) / 5 + 1);
    expect(timeline7d.series.length).toBe((7 * 24 * 60) / 5 + 1);
    expect(timeline7d.series.length).toBeGreaterThan(timeline24h.series.length);
    expect(timeline7dZoomed.pointIntervalMinutes).toBe(1);
    expect(timeline7dZoomed.series.length).toBe((7 * 24 * 60) / 1 + 1);
    expect(timeline7dZoomed.series.length).toBeGreaterThan(timeline7d.series.length);
  });

  it('returns the curated health trends board', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });

    const trends = await repository.getTrendData('14d');

    expect(trends.primaryMetrics.map((metric) => metric.id)).toEqual([
      'recovery',
      'hrv',
      'restingHr',
      'sleepScore',
    ]);
    expect(trends.secondaryMetrics.map((metric) => metric.id)).toEqual([
      'sleepDuration',
      'sleepConsistency',
      'stress',
      'skinTemperatureDeviation',
    ]);
    expect(trends.primaryMetrics.find((metric) => metric.id === 'hrv')).toMatchObject({
      latest: 82,
      unit: 'ms',
    });
    expect(trends.secondaryMetrics.find((metric) => metric.id === 'skinTemperatureDeviation')).toMatchObject({
      latest: 0.2,
      unit: '°C',
    });
  });

  it('requires alarm confirmation after the wake-up target changes', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });

    await repository.setTargetWakeMinutes(6 * 60 + 30);
    let sleep = await repository.getSleepHistory('14d');
    expect(sleep.sleepPlan.targetWakeTime).toBe('6:30 AM');
    expect(sleep.sleepPlan.alarmEnabled).toBe(false);

    await repository.disableAlarm(6 * 60 + 30);
    sleep = await repository.getSleepHistory('14d');
    expect(sleep.sleepPlan.alarmEnabled).toBe(false);
    expect(sleep.sleepPlan.targetWakeTime).toBe('6:30 AM');

    await repository.enableAlarm(6 * 60 + 30);
    sleep = await repository.getSleepHistory('14d');
    expect(sleep.sleepPlan.alarmEnabled).toBe(true);
    expect(sleep.sleepPlan.targetWakeTime).toBe('6:30 AM');
  });

  it('rescans activities by clearing pending detections while preserving reviewed history', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });

    await repository.dismissActivity('activity-tempo-run');
    const manualId = await repository.createManualActivity(
      'Nap',
      new Date(2026, 3, 23, 14, 0, 0),
      new Date(2026, 3, 23, 14, 35, 0),
    );

    const result = await repository.rescanActivities();
    const wellness = await repository.getWellnessData('14d');

    expect(result).toEqual({
      removedUnconfirmedActivities: 2,
    });
    expect(wellness.activities.some((activity) => activity.id === 'activity-tempo-run')).toBe(false);
    expect(wellness.activities.map((activity) => activity.id)).toEqual(
      expect.arrayContaining([manualId, 'activity-mobility-reset', 'activity-evening-walk']),
    );
  });

  it('returns denser focused heart detail for short activity markers', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });
    const overview = await repository.getHistoryOverview('2026-04-23');
    const marker = overview.heartCard.markers.find((candidate) => candidate.id === 'activity-mobility-reset');

    expect(marker).toBeDefined();

    const detail = await repository.getFocusedHeartDetail(marker!);

    expect(detail.pointIntervalMinutes).toBe(0.5);
    expect(detail.series).toHaveLength(37);
    expect(detail.marker.id).toBe('activity-mobility-reset');
    expect(detail.marker.startFraction).toBe(0);
    expect(detail.marker.endFraction).toBe(1);
    expect(detail.missingReason).toBeNull();
  });
});
