import { Platform } from 'react-native';

import type { ActiveActivity } from '@/data/HealthRepository';
import ActivityLiveActivity, { type ActivityLiveActivityProps } from '@/widgets/ActivityLiveActivity';

const ACTIVITY_LIVE_ACTIVITY_URL = 'btwearable://';
const ACTIVITY_LIVE_ACTIVITY_RELEVANCE_SCORE = 1;
export const ACTIVITY_STOP_URL = 'btwearable://activity-stop?source=live-activity';

export type ActivityLiveActivityResult =
  | { ok: true }
  | { ok: false; message: string };

function activityLiveActivityFailureMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return detail
    ? `The iOS Live Activity could not be started. The run is still active in the app. ${detail}`
    : 'The iOS Live Activity could not be started. The run is still active in the app.';
}

function getActivityLiveActivityInstances() {
  try {
    return ActivityLiveActivity.getInstances();
  } catch {
    return [];
  }
}

export function buildActivityLiveActivityProps(
  activity: ActiveActivity,
  options: { liveHeartRate?: number | null } = {},
): ActivityLiveActivityProps {
  return {
    activityId: activity.id,
    activityName: activity.activity,
    liveHeartRate: options.liveHeartRate ?? null,
    startTimestamp: activity.start.getTime(),
    stopUrl: ACTIVITY_STOP_URL,
  };
}

export async function startOrUpdateActivityLiveActivity(
  activity: ActiveActivity,
  options: { liveHeartRate?: number | null } = {},
): Promise<ActivityLiveActivityResult> {
  if (Platform.OS !== 'ios') {
    return { ok: true };
  }

  const props = buildActivityLiveActivityProps(activity, options);
  const instances = getActivityLiveActivityInstances();

  if (instances.length === 0) {
    try {
      ActivityLiveActivity.start(props, ACTIVITY_LIVE_ACTIVITY_URL, {
        relevanceScore: ACTIVITY_LIVE_ACTIVITY_RELEVANCE_SCORE,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: activityLiveActivityFailureMessage(error) };
    }
  }

  const failures: unknown[] = [];
  const updateResults = await Promise.all(
    instances.map(async (instance) => {
      try {
        await instance.update(props, {
          relevanceScore: ACTIVITY_LIVE_ACTIVITY_RELEVANCE_SCORE,
        });
        return true;
      } catch (error) {
        failures.push(error);
      }

      return false;
    }),
  );

  if (updateResults.some(Boolean)) {
    return { ok: true };
  }

  return { ok: false, message: activityLiveActivityFailureMessage(failures[0]) };
}

export async function endActivityLiveActivities() {
  if (Platform.OS !== 'ios') {
    return;
  }

  const instances = getActivityLiveActivityInstances();

  await Promise.all(
    instances.map(async (instance) => {
      try {
        await instance.end('immediate');
      } catch {}
    }),
  );
}
