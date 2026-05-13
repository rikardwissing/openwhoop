import type { SleepHistoryData } from '@/types/health';
import { buildSleepThemeStatus } from '@/utils/sleepPlan';

import {
  getAlternateIconNameAsync,
  setAlternateIconNameAsync,
  supportsAlternateIconsAsync,
  type AlternateAppIconName,
} from './alternateAppIcon';

type WindDownIconSnapshot = Pick<
  SleepHistoryData,
  'completionStatus' | 'isInProgress' | 'sessions' | 'sleepPlan'
>;

let lastAppliedDesiredIcon: AlternateAppIconName | undefined;

export function getDesiredWindDownAppIcon(snapshot: WindDownIconSnapshot, now = new Date()): AlternateAppIconName {
  return buildSleepThemeStatus(snapshot, now).sleepThemeActive ? 'WindDown' : null;
}

export async function syncWindDownAppIcon(snapshot: WindDownIconSnapshot, now = new Date()) {
  const desiredIcon = getDesiredWindDownAppIcon(snapshot, now);

  if (lastAppliedDesiredIcon === desiredIcon) {
    return;
  }

  if (!(await supportsAlternateIconsAsync())) {
    lastAppliedDesiredIcon = desiredIcon;
    return;
  }

  const currentIcon = await getAlternateIconNameAsync();

  if (currentIcon !== desiredIcon) {
    await setAlternateIconNameAsync(desiredIcon);
  }

  lastAppliedDesiredIcon = desiredIcon;
}
