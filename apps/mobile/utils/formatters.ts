import type { SleepStage } from '@/types/health';

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

function parseClockLabel(label: string): number | null {
  const match = label.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([AP]M)?$/i);
  if (!match) {
    return null;
  }

  const [, rawHour, rawMinute = '0', meridiem] = match;
  const hour = Number(rawHour);
  const minute = Number(rawMinute);

  if (Number.isNaN(hour) || Number.isNaN(minute) || minute < 0 || minute > 59) {
    return null;
  }

  if (!meridiem) {
    if (hour < 0 || hour > 23) {
      return null;
    }

    return hour * 60 + minute;
  }

  if (hour < 1 || hour > 12) {
    return null;
  }

  const normalizedHour = hour % 12 + (meridiem.toUpperCase() === 'PM' ? 12 : 0);
  return normalizedHour * 60 + minute;
}

function formatClockMinutes(totalMinutes: number) {
  const normalized = ((Math.round(totalMinutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;

  return `${hour12}:${`${minute}`.padStart(2, '0')} ${meridiem}`;
}

export function formatClockRangeFromStartLabel(
  startLabel: string,
  startMinute: number,
  endMinute: number,
) {
  const baseMinutes = parseClockLabel(startLabel);
  if (baseMinutes === null) {
    return `${startMinute}-${endMinute} min`;
  }

  return `${formatClockMinutes(baseMinutes + startMinute)}-${formatClockMinutes(
    baseMinutes + endMinute,
  )}`;
}

export function formatSleepStageLabel(stage: SleepStage) {
  if (stage === 'rem') {
    return 'REM sleep';
  }

  return `${stage[0].toUpperCase()}${stage.slice(1)} sleep`;
}
