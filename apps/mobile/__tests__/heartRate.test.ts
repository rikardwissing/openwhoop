import { sustainedPeakBpm } from '@/utils/heartRate';

describe('heartRate', () => {
  it('uses a sustained three-sample peak instead of a single-sample spike', () => {
    expect(sustainedPeakBpm([72, 74, 201, 75, 76])).toBe(117);
  });

  it('keeps a real elevated effort block near its sustained level', () => {
    expect(sustainedPeakBpm([118, 142, 148, 146, 131])).toBe(145);
  });

  it('falls back cleanly for short histories', () => {
    expect(sustainedPeakBpm([88, 92])).toBe(90);
    expect(sustainedPeakBpm([91])).toBe(91);
    expect(sustainedPeakBpm([])).toBeNull();
  });
});
