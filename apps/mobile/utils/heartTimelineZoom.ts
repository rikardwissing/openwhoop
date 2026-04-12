export const HEART_TIMELINE_ZOOM_PRESETS = [
  {
    bucketMinutes: 2,
    label: '3H',
    latestLabel: 'Last 3h',
    value: '3h',
    windowMinutes: 3 * 60,
  },
  {
    bucketMinutes: 2,
    label: '6H',
    latestLabel: 'Last 6h',
    value: '6h',
    windowMinutes: 6 * 60,
  },
  {
    bucketMinutes: 5,
    label: '12H',
    latestLabel: 'Last 12h',
    value: '12h',
    windowMinutes: 12 * 60,
  },
  {
    bucketMinutes: 5,
    label: '24H',
    latestLabel: 'Last 24h',
    value: '24h',
    windowMinutes: 24 * 60,
  },
  {
    bucketMinutes: 5,
    label: '7D',
    latestLabel: 'Last 7d',
    value: '7d',
    windowMinutes: 7 * 24 * 60,
  },
] as const;

export const HEART_TIMELINE_BUCKET_PRESETS = [
  {
    label: 'Auto',
    value: 'auto',
  },
  {
    bucketMinutes: 0.5,
    label: '30s',
    value: '30s',
  },
  {
    bucketMinutes: 1,
    label: '1m',
    value: '1m',
  },
  {
    bucketMinutes: 2,
    label: '2m',
    value: '2m',
  },
  {
    bucketMinutes: 5,
    label: '5m',
    value: '5m',
  },
] as const;

export type HeartTimelineZoomLevel = (typeof HEART_TIMELINE_ZOOM_PRESETS)[number]['value'];
export type HeartTimelineBucketLevel = (typeof HEART_TIMELINE_BUCKET_PRESETS)[number]['value'];

export function getHeartTimelineZoomPreset(zoomLevel: HeartTimelineZoomLevel) {
  return HEART_TIMELINE_ZOOM_PRESETS.find((preset) => preset.value === zoomLevel) ?? HEART_TIMELINE_ZOOM_PRESETS[0];
}

export function getHeartTimelineBucketMinutes(
  bucketLevel: HeartTimelineBucketLevel,
  zoomLevel: HeartTimelineZoomLevel,
) {
  if (bucketLevel === 'auto') {
    return getHeartTimelineZoomPreset(zoomLevel).bucketMinutes;
  }

  const resolvedPreset = HEART_TIMELINE_BUCKET_PRESETS.find(
    (preset): preset is Exclude<(typeof HEART_TIMELINE_BUCKET_PRESETS)[number], { value: 'auto' }> =>
      preset.value === bucketLevel && 'bucketMinutes' in preset,
  );

  return resolvedPreset?.bucketMinutes ?? getHeartTimelineZoomPreset(zoomLevel).bucketMinutes;
}

export function getHeartTimelineWindowPointCount(
  zoomLevel: HeartTimelineZoomLevel,
  pointIntervalMinutes: number | undefined,
  totalPoints: number,
) {
  const safeTotalPoints = Math.max(totalPoints, 1);
  const safePointIntervalMinutes = Math.max(pointIntervalMinutes ?? 5, 1 / 60);
  const targetPointCount = Math.floor(getHeartTimelineZoomPreset(zoomLevel).windowMinutes / safePointIntervalMinutes) + 1;

  return Math.min(safeTotalPoints, Math.max(targetPointCount, 2));
}