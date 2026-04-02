export function formatDuration(minutes: number | null): string {
  if (minutes === null) {
    return '--';
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatCompactDuration(minutes: number | null): string {
  if (minutes === null) {
    return '--';
  }

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

export function formatMetricNumber(value: number | null, unit: string, digits = 0): string {
  if (value === null) {
    return `-- ${unit}`.trim();
  }

  return `${value.toFixed(digits)} ${unit}`.trim();
}

export function describeRecovery(score: number | null): string {
  if (score === null) {
    return 'Waiting';
  }

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

export function describeSleepScore(score: number | null): string {
  if (score === null) {
    return 'Waiting for sleep';
  }

  if (score >= 90) {
    return 'Excellent sleep';
  }

  if (score >= 80) {
    return 'Good sleep';
  }

  if (score >= 65) {
    return 'Recovering';
  }

  return 'Short night';
}

export function formatNullablePercent(value: number | null): string {
  if (value === null) {
    return '--';
  }

  return `${Math.round(value)}%`;
}
