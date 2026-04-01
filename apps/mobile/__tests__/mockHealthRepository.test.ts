import { MockHealthRepository } from '@/data/mock/MockHealthRepository';

describe('MockHealthRepository', () => {
  it('returns seeded dashboard and wellness data', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });

    const dashboard = await repository.getDashboardSnapshot();
    const wellness = await repository.getWellnessSnapshot('14d');

    expect(dashboard.recovery.score).toBe(64);
    expect(dashboard.summaryStats).toHaveLength(3);
    expect(wellness.activities).toHaveLength(3);
    expect(wellness.skinTemperature.hasPartialData).toBe(true);
  });
});
