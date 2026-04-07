import { MockHealthRepository } from '@/data/mock/MockHealthRepository';

describe('MockHealthRepository', () => {
  it('returns seeded dashboard and wellness data', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });

    const dashboard = await repository.getDashboardSnapshot();
    const historyDashboard = await repository.getDashboardSnapshot('2026-04-23');
    const heart = await repository.getHeartHistory('14d');
    const wellness = await repository.getWellnessSnapshot('14d');

    expect(dashboard.recovery.score).toBe(64);
    expect(dashboard.summaryStats).toHaveLength(4);
    expect(dashboard.heartCard.series.length).toBe(145);
    expect(dashboard.heartCard.markers).toHaveLength(1);
    expect(historyDashboard.heartCard.series.length).toBe(288);
    expect(dashboard.activitySummary).toHaveLength(3);
    expect(dashboard.insights.length).toBeGreaterThan(0);
    expect(heart.intraday.length).toBe(288);
    expect(heart.intradayMarkers).toHaveLength(4);
    expect(heart.intradayMarkers[0]?.kind).toBe('sleep');
    expect(heart.intraday[1]?.label).toBe('12:05 AM');
    expect(wellness.activities).toHaveLength(3);
    expect(wellness.skinTemperature.hasPartialData).toBe(true);
  });

  it('expands dashboard heart timelines by requested range without changing the heart screen intraday contract', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });

    const timeline24h = await repository.getDashboardHeartTimeline('24h');
    const timeline7d = await repository.getDashboardHeartTimeline('7d');

    expect(timeline24h.series.length).toBe((24 * 60) / 5);
    expect(timeline7d.series.length).toBe((7 * 24 * 60) / 5);
    expect(timeline7d.series.length).toBeGreaterThan(timeline24h.series.length);
  });

  it('returns the curated health trends board', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });

    const trends = await repository.getTrendSnapshot('14d');

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
});
