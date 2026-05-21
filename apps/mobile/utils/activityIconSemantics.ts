import type { ManualActivityKind } from '@/data/HealthRepository';

export type ActivityIconSemantic = 'activity' | 'walk' | 'running' | 'workout' | 'nap';

export function getActivityIconSemantic(activity: ManualActivityKind): ActivityIconSemantic {
  switch (activity) {
    case 'Walk':
      return 'walk';
    case 'Running':
      return 'running';
    case 'Workout':
      return 'workout';
    case 'Nap':
      return 'nap';
    case 'Activity':
    default:
      return 'activity';
  }
}

export function getActivityIconSemanticFromLabel(label: string): ActivityIconSemantic {
  const normalized = label.trim().toLowerCase();

  if (normalized.includes('nap')) {
    return 'nap';
  }

  if (normalized.includes('run') || normalized.includes('jog') || normalized.includes('sprint')) {
    return 'running';
  }

  if (normalized.includes('walk') || normalized.includes('stroll') || normalized.includes('hike')) {
    return 'walk';
  }

  if (
    normalized.includes('workout') ||
    normalized.includes('mobility') ||
    normalized.includes('strength') ||
    normalized.includes('lift') ||
    normalized.includes('training') ||
    normalized.includes('gym')
  ) {
    return 'workout';
  }

  return 'activity';
}