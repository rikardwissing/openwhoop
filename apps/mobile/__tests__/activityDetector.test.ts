import { detectActivityArtifacts, type ActivityDetectorInputRow } from '@/data/sqlite/activityDetector';

function makeRow(
  date: Date,
  bpm: number,
  gravity: [number, number, number] | null,
  overrides: Partial<ActivityDetectorInputRow> = {},
): ActivityDetectorInputRow {
  const baselineRr = Math.max(300, Math.round(60000 / Math.max(bpm, 1)));

  return {
    date,
    bpm,
    rr: [baselineRr, baselineRr - 4, baselineRr + 4],
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

  it('drops short borderline daytime walk bouts that only barely clear the detector evidence floor', () => {
    const rows: ActivityDetectorInputRow[] = [];
    const start = new Date(2026, 3, 6, 7, 0, 0);
    const restGravityA: [number, number, number] = [0.15, -0.02, 0.97];
    const restGravityB: [number, number, number] = [0.162, -0.018, 0.968];
    const walkGravityA: [number, number, number] = [0.35, -0.42, 0.84];
    const walkGravityB: [number, number, number] = [-0.28, -0.81, 0.51];

    for (let minute = 0; minute < 4 * 60; minute += 1) {
      const date = new Date(start.getTime() + minute * 60_000);
      const isWalk = minute >= 95 && minute < 113;
      rows.push(makeRow(
        date,
        isWalk ? 82 : 65,
        isWalk ? (minute % 2 === 0 ? walkGravityA : walkGravityB) : (minute % 2 === 0 ? restGravityA : restGravityB),
      ));
    }

    const artifacts = detectActivityArtifacts(rows);

    expect(artifacts.activityCandidates).toHaveLength(0);
  });

  it('keeps sustained stronger daytime exercise bouts as activity candidates', () => {
    const rows: ActivityDetectorInputRow[] = [];
    const start = new Date(2026, 3, 6, 7, 0, 0);
    const restGravityA: [number, number, number] = [0.15, -0.02, 0.97];
    const restGravityB: [number, number, number] = [0.162, -0.018, 0.968];
    const workoutGravityA: [number, number, number] = [0.35, -0.42, 0.84];
    const workoutGravityB: [number, number, number] = [-0.28, -0.81, 0.51];

    for (let minute = 0; minute < 4 * 60; minute += 1) {
      const date = new Date(start.getTime() + minute * 60_000);
      const isWorkout = minute >= 95 && minute < 121;
      rows.push(makeRow(
        date,
        isWorkout ? 112 : 65,
        isWorkout ? (minute % 2 === 0 ? workoutGravityA : workoutGravityB) : (minute % 2 === 0 ? restGravityA : restGravityB),
      ));
    }

    const artifacts = detectActivityArtifacts(rows);

    expect(artifacts.activityCandidates).toHaveLength(1);
    expect(artifacts.activityCandidates[0]?.kind).toBe('workout');
    expect(artifacts.activityCandidates[0]?.durationMinutes).toBeGreaterThanOrEqual(20);
  });

  it('does not classify steady high-heart medium-motion windows without a heart-rate rise', () => {
    const rows: ActivityDetectorInputRow[] = [];
    const start = new Date(2026, 3, 6, 7, 0, 0);
    const restGravityA: [number, number, number] = [0.15, -0.02, 0.97];
    const restGravityB: [number, number, number] = [0.162, -0.018, 0.968];
    const activeGravityA: [number, number, number] = [0.35, -0.42, 0.84];
    const activeGravityB: [number, number, number] = [-0.28, -0.81, 0.51];

    for (let minute = 0; minute < 4 * 60; minute += 1) {
      const date = new Date(start.getTime() + minute * 60_000);
      const isMediumMotion = minute >= 90 && minute < 115;
      rows.push(makeRow(
        date,
        90,
        isMediumMotion ? (minute % 2 === 0 ? activeGravityA : activeGravityB) : (minute % 2 === 0 ? restGravityA : restGravityB),
      ));
    }

    const artifacts = detectActivityArtifacts(rows);

    expect(artifacts.activityCandidates).toHaveLength(0);
  });

  it('keeps medium-motion windows when heart rate rises into the bout', () => {
    const rows: ActivityDetectorInputRow[] = [];
    const start = new Date(2026, 3, 6, 7, 0, 0);
    const restGravityA: [number, number, number] = [0.15, -0.02, 0.97];
    const restGravityB: [number, number, number] = [0.162, -0.018, 0.968];
    const activeGravityA: [number, number, number] = [0.35, -0.42, 0.84];
    const activeGravityB: [number, number, number] = [-0.28, -0.81, 0.51];

    for (let minute = 0; minute < 4 * 60; minute += 1) {
      const date = new Date(start.getTime() + minute * 60_000);
      const isMediumMotion = minute >= 90 && minute < 115;
      rows.push(makeRow(
        date,
        isMediumMotion ? 98 : 90,
        isMediumMotion ? (minute % 2 === 0 ? activeGravityA : activeGravityB) : (minute % 2 === 0 ? restGravityA : restGravityB),
      ));
    }

    const artifacts = detectActivityArtifacts(rows);

    expect(artifacts.activityCandidates).toHaveLength(1);
    expect(['activity', 'walk', 'workout']).toContain(artifacts.activityCandidates[0]?.kind);
  });

  it('does not bridge two short bouts across a four-minute rest gap anymore', () => {
    const rows: ActivityDetectorInputRow[] = [];
    const start = new Date(2026, 3, 6, 7, 0, 0);
    const restGravityA: [number, number, number] = [0.15, -0.02, 0.97];
    const restGravityB: [number, number, number] = [0.162, -0.018, 0.968];
    const activeGravityA: [number, number, number] = [0.35, -0.42, 0.84];
    const activeGravityB: [number, number, number] = [-0.28, -0.81, 0.51];

    for (let minute = 0; minute < 5 * 60; minute += 1) {
      const date = new Date(start.getTime() + minute * 60_000);
      const isFirstBout = minute >= 90 && minute < 105;
      const isSecondBout = minute >= 109 && minute < 124;
      const isActive = isFirstBout || isSecondBout;
      rows.push(makeRow(
        date,
        isActive ? 112 : 65,
        isActive ? (minute % 2 === 0 ? activeGravityA : activeGravityB) : (minute % 2 === 0 ? restGravityA : restGravityB),
      ));
    }

    const artifacts = detectActivityArtifacts(rows);

    expect(artifacts.activityCandidates).toHaveLength(0);
  });

  it('rejects activity-like bouts when RR-derived physiology strongly disagrees with bpm', () => {
    const rows: ActivityDetectorInputRow[] = [];
    const start = new Date(2026, 3, 6, 7, 0, 0);
    const restGravityA: [number, number, number] = [0.15, -0.02, 0.97];
    const restGravityB: [number, number, number] = [0.162, -0.018, 0.968];
    const activeGravityA: [number, number, number] = [0.35, -0.42, 0.84];
    const activeGravityB: [number, number, number] = [-0.28, -0.81, 0.51];

    for (let minute = 0; minute < 4 * 60; minute += 1) {
      const date = new Date(start.getTime() + minute * 60_000);
      const isActive = minute >= 95 && minute < 121;
      rows.push(makeRow(
        date,
        isActive ? 112 : 65,
        isActive ? (minute % 2 === 0 ? activeGravityA : activeGravityB) : (minute % 2 === 0 ? restGravityA : restGravityB),
        {
          rr: isActive ? [720, 724, 716] : undefined,
        },
      ));
    }

    const artifacts = detectActivityArtifacts(rows);

    expect(artifacts.activityCandidates).toHaveLength(0);
  });

  it('keeps activity-like bouts when RR-derived physiology agrees with bpm', () => {
    const rows: ActivityDetectorInputRow[] = [];
    const start = new Date(2026, 3, 6, 7, 0, 0);
    const restGravityA: [number, number, number] = [0.15, -0.02, 0.97];
    const restGravityB: [number, number, number] = [0.162, -0.018, 0.968];
    const activeGravityA: [number, number, number] = [0.35, -0.42, 0.84];
    const activeGravityB: [number, number, number] = [-0.28, -0.81, 0.51];

    for (let minute = 0; minute < 4 * 60; minute += 1) {
      const date = new Date(start.getTime() + minute * 60_000);
      const isActive = minute >= 95 && minute < 121;
      rows.push(makeRow(
        date,
        isActive ? 112 : 65,
        isActive ? (minute % 2 === 0 ? activeGravityA : activeGravityB) : (minute % 2 === 0 ? restGravityA : restGravityB),
        {
          rr: isActive ? [536, 540, 544] : undefined,
        },
      ));
    }

    const artifacts = detectActivityArtifacts(rows);

    expect(artifacts.activityCandidates).toHaveLength(1);
    expect(artifacts.activityCandidates[0]?.kind).toBe('workout');
  });

});