import { describeRecovery, formatCompactDuration, formatDuration, formatSignedValue } from '@/utils/formatters';

describe('formatters', () => {
  it('formats durations for cards and compact labels', () => {
    expect(formatDuration(465)).toBe('7h 45m');
    expect(formatCompactDuration(465)).toBe('7:45');
  });

  it('formats signed values and recovery labels', () => {
    expect(formatSignedValue(-4, 0)).toBe('-4');
    expect(formatSignedValue(0.3, 1)).toBe('+0.3');
    expect(describeRecovery(64)).toBe('Balanced');
  });
});
