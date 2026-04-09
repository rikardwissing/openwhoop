import { detectActivityArtifacts, type ActivityDetectorInputRow } from '@/data/sqlite/activityDetector';

function makeRow(
  date: Date,
  bpm: number,
  gravity: [number, number, number] | null,
  overrides: Partial<ActivityDetectorInputRow> = {},
): ActivityDetectorInputRow {
  return {
    date,
    bpm,
    rr: [1000, 990, 980],
    gravity,
    skinContact: 1,
    signalQuality: 3074,
    ppgGreen: 18_000,
    ...overrides,
  };
}

describe('activityDetector sleep candidates', () => {
  it('keeps dense overnight sleep onset instead of collapsing it into wake on 1Hz data', () => {
    const rows: ActivityDetectorInputRow[] = [];
    const start = new Date(2026, 3, 5, 0, 0, 0);

    for (let second = 0; second < 9 * 60 * 60; second += 1) {
      const date = new Date(start.getTime() + second * 1000);
      const sleeping = second >= 2.5 * 60 * 60;

      const gravity: [number, number, number] = sleeping
        ? [
            0.53 + (second % 2 === 0 ? 0.006 : -0.006),
            0.2 + (second % 3 === 0 ? 0.005 : -0.005),
            0.9 + (second % 4 === 0 ? 0.004 : -0.004),
          ]
        : [
            0.18 + Math.sin(second / 4) * 0.3,
            -0.35 + Math.cos(second / 3) * 0.28,
            0.7 + Math.sin(second / 5) * 0.18,
          ];

      rows.push(makeRow(date, sleeping ? 54 : 71, gravity));
    }

    const artifacts = detectActivityArtifacts(rows);
    const overnightSleep = artifacts.sleepCandidates.find((period) => period.durationMinutes >= 180);

    expect(overnightSleep).toBeTruthy();
    expect(overnightSleep!.start.getTime()).toBeGreaterThanOrEqual(new Date(2026, 3, 5, 2, 20, 0).getTime());
    expect(overnightSleep!.start.getTime()).toBeLessThanOrEqual(new Date(2026, 3, 5, 2, 45, 0).getTime());
  });

  it('does not classify sustained daytime wrist movement as activity without imu or a heart-rate lift', () => {
    const rows: ActivityDetectorInputRow[] = [];
    const start = new Date(2026, 3, 6, 9, 0, 0);
    const wristMotionA: [number, number, number] = [0.55, -0.58, 0.61];
    const wristMotionB: [number, number, number] = [-0.42, 0.73, 0.54];

    for (let minute = 0; minute < 90; minute += 1) {
      rows.push(makeRow(
        new Date(start.getTime() + minute * 60_000),
        66,
        minute % 2 === 0 ? wristMotionA : wristMotionB,
      ));
    }

    const artifacts = detectActivityArtifacts(rows);

    expect(artifacts.sleepCandidates).toHaveLength(0);
    expect(artifacts.activityCandidates).toHaveLength(0);
  });

});