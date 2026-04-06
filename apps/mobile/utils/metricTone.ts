import type { MetricTone } from '@/types/health';

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
