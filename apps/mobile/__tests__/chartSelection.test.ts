import {
  buildTrendCoordinates,
  buildTrendDomain,
  buildSleepStageFrames,
  selectSleepStageAtX,
  selectTrendPointAtX,
} from '@/components/charts/chartSelection';

describe('chart selection helpers', () => {
  it('selects the nearest trend point for a touch position', () => {
    const selection = selectTrendPointAtX(
      [
        { label: 'A', value: 10 },
        { label: 'B', value: 20 },
        { label: 'C', value: 30 },
      ],
      300,
      260,
    );

    expect(selection).toEqual({
      index: 2,
      point: { label: 'C', value: 30 },
    });
  });

  it('can select a missing trend bucket without collapsing the gap', () => {
    const selection = selectTrendPointAtX(
      [
        { label: 'A', value: 10 },
        { label: 'B', value: null },
        { label: 'C', value: 30 },
      ],
      300,
      150,
    );

    expect(selection).toEqual({
      index: 1,
      point: { label: 'B', value: null },
    });
  });

  it('pads positive line-chart domains beyond the raw min and max', () => {
    const domain = buildTrendDomain(
      [
        { label: 'A', value: 48 },
        { label: 'B', value: 52 },
        { label: 'C', value: 50 },
      ],
      { mode: 'line' },
    );

    expect(domain).toEqual(
      expect.objectContaining({
        min: expect.any(Number),
        max: expect.any(Number),
      }),
    );
    expect(domain?.min).toBeLessThan(48);
    expect(domain?.max).toBeGreaterThan(52);
  });

  it('does not anchor positive bar charts to the exact series minimum', () => {
    const domain = buildTrendDomain(
      [
        { label: 'A', value: 71 },
        { label: 'B', value: 76 },
        { label: 'C', value: 82 },
      ],
      { mode: 'bar' },
    );

    expect(domain?.min).toBeLessThan(71);
    expect(domain?.max).toBeGreaterThan(82);
  });

  it('centers signed bar domains around zero for deviation charts', () => {
    const domain = buildTrendDomain(
      [
        { label: 'A', value: -0.3 },
        { label: 'B', value: 0.1 },
        { label: 'C', value: 0.25 },
      ],
      { mode: 'bar' },
    );

    expect(domain).not.toBeNull();
    expect(domain!.min).toBeLessThan(0);
    expect(domain!.max).toBeGreaterThan(0);
    expect(Math.abs(domain!.max + domain!.min)).toBeLessThan(0.0001);
  });

  it('places negative signed bars below the zero line', () => {
    const coordinates = buildTrendCoordinates(
      [
        { label: 'A', value: -0.2 },
        { label: 'B', value: 0.3 },
      ],
      { mode: 'bar' },
    );

    expect(coordinates[0]?.y).not.toBeNull();
    expect(coordinates[1]?.y).not.toBeNull();
    expect((coordinates[0]?.y ?? 0) > (coordinates[1]?.y ?? 0)).toBe(true);
  });

  it('builds cumulative sleep-stage offsets', () => {
    expect(
      buildSleepStageFrames([
        { stage: 'light', minutes: 30 },
        { stage: 'deep', minutes: 45 },
        { stage: 'rem', minutes: 15 },
      ]),
    ).toEqual([
      expect.objectContaining({ index: 0, startMinute: 0, endMinute: 30 }),
      expect.objectContaining({ index: 1, startMinute: 30, endMinute: 75 }),
      expect.objectContaining({ index: 2, startMinute: 75, endMinute: 90 }),
    ]);
  });

  it('selects the correct sleep-stage segment and offsets', () => {
    const selection = selectSleepStageAtX(
      [
        { stage: 'light', minutes: 30 },
        { stage: 'deep', minutes: 45 },
        { stage: 'rem', minutes: 15 },
      ],
      180,
      95,
    );

    expect(selection).toEqual({
      index: 1,
      segment: { stage: 'deep', minutes: 45 },
      startMinute: 30,
      endMinute: 75,
    });
  });
});
