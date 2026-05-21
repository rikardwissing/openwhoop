import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

import type { ManualActivityKind } from '@/data/HealthRepository';
import { getActivityIconSemantic, getActivityIconSemanticFromLabel } from '@/utils/activityIconSemantics';

export type ActivityIoniconName = ComponentProps<typeof Ionicons>['name'];

function getIoniconNameForSemantic(semantic: ReturnType<typeof getActivityIconSemantic>): ActivityIoniconName {
  switch (semantic) {
    case 'walk':
      return 'footsteps';
    case 'running':
      return 'walk';
    case 'workout':
      return 'barbell';
    case 'nap':
      return 'time-outline';
    case 'activity':
    default:
      return 'pulse';
  }
}

export function getManualActivityIconName(activity: ManualActivityKind): ActivityIoniconName {
  return getIoniconNameForSemantic(getActivityIconSemantic(activity));
}

export function getActivityIconNameFromLabel(label: string): ActivityIoniconName {
  return getIoniconNameForSemantic(getActivityIconSemanticFromLabel(label));
}