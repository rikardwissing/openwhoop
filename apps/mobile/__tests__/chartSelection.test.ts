import {
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
