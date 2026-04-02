import { MockHealthRepository } from '@/data/mock/MockHealthRepository';

describe('MockHealthRepository', () => {
  it('returns seeded dashboard and wellness data', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });

    const dashboard = await repository.getDashboardSnapshot();
    const heart = await repository.getHeartHistory('14d');
    const wellness = await repository.getWellnessSnapshot('14d');

    expect(dashboard.recovery.score).toBe(64);
    expect(dashboard.summaryStats).toHaveLength(3);
    expect(dashboard.heartCard.series.length).toBe(288);
    expect(heart.intraday.length).toBe(288);
    expect(heart.intraday[1]?.label).toBe('12:05 AM');
    expect(wellness.activities).toHaveLength(3);
    expect(wellness.skinTemperature.hasPartialData).toBe(true);
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
