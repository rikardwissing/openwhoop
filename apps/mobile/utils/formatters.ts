export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatCompactDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = `${minutes % 60}`.padStart(2, '0');
  return `${hours}:${remainingMinutes}`;
}

export function formatSignedValue(value: number | null, digits = 1): string {
  if (value === null) {
    return '--';
  }

  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(digits)}`;
}

export function formatMetricValue(value: number | null, digits = 0): string {
  if (value === null) {
    return '--';
  }

  return value.toFixed(digits);
}

export function describeRecovery(score: number): string {
  if (score >= 82) {
    return 'Optimized';
  }

  if (score >= 68) {
    return 'Ready';
  }

  if (score >= 50) {
    return 'Balanced';
  }

  return 'Recharge';
}
