import { formatAxisTime } from '@/utils/dateTime';

describe('dateTime', () => {
  it('keeps minute precision for non-hour axis labels', () => {
    expect(formatAxisTime(new Date(2026, 3, 2, 18, 0, 0, 0))).toBe('6 PM');
    expect(formatAxisTime(new Date(2026, 3, 2, 18, 15, 0, 0))).toBe('6:15 PM');
  });
});
