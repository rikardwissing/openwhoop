import { colors } from '@/constants/theme';
import type { MetricTone } from '@/types/health';

export function getMetricToneColor(tone: MetricTone): string {
  switch (tone) {
    case 'good':
      return colors.success;
    case 'caution':
      return colors.heart;
    case 'alert':
      return colors.alert;
    default:
      return colors.cyan;
  }
}

export function getRecoveryMetricTone(score: number | null): MetricTone {
  if (score === null) {
    return 'neutral';
  }

  if (score >= 68) {
    return 'good';
  }

  if (score >= 50) {
    return 'caution';
  }

  return 'alert';
}

export function getSleepMetricTone(score: number | null): MetricTone {
  if (score === null) {
    return 'neutral';
  }

  if (score >= 80) {
    return 'good';
  }

  if (score >= 65) {
    return 'caution';
  }

  return 'alert';
}

export function getStrainMetricTone(score: number | null): MetricTone {
  if (score === null) {
    return 'neutral';
  }

  if (score >= 14) {
    return 'alert';
  }

  if (score >= 8) {
    return 'good';
  }

  return 'neutral';
}
