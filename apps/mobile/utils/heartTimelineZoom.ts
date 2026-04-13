export const HEART_TIMELINE_POINT_INTERVAL_MINUTES = 5;

export const HEART_TIMELINE_ZOOM_PRESETS = [
  {
    label: '1H',
    latestLabel: 'Last 1h',
    value: '1h',
    windowMinutes: 1 * 60,
  },
  {
    label: '3H',
    latestLabel: 'Last 3h',
    value: '3h',
    windowMinutes: 3 * 60,
  },
  {
    label: '6H',
    latestLabel: 'Last 6h',
    value: '6h',
    windowMinutes: 6 * 60,
  },
  {
    label: '12H',
    latestLabel: 'Last 12h',
    value: '12h',
    windowMinutes: 12 * 60,
  },
  {
    label: '24H',
    latestLabel: 'Last 24h',
    value: '24h',
    windowMinutes: 24 * 60,
  },
  {
    label: '48H',
    latestLabel: 'Last 48h',
    value: '48h',
    windowMinutes: 48 * 60,
  },
] as const;

export type HeartTimelineZoomPreset = (typeof HEART_TIMELINE_ZOOM_PRESETS)[number];
export type HeartTimelineZoomLevel = (typeof HEART_TIMELINE_ZOOM_PRESETS)[number]['value'];

export type HeartTimelineZoomStep = HeartTimelineZoomPreset & {
  windowPointCount: number;
};

export function getHeartTimelineZoomPreset(zoomLevel: HeartTimelineZoomLevel) {
  return HEART_TIMELINE_ZOOM_PRESETS.find((preset) => preset.value === zoomLevel) ?? HEART_TIMELINE_ZOOM_PRESETS[2];
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

export function getHeartTimelineZoomSteps(
  pointIntervalMinutes: number | undefined,
  totalPoints: number,
): HeartTimelineZoomStep[] {
  return HEART_TIMELINE_ZOOM_PRESETS.map((preset) => ({
    ...preset,
    windowPointCount: getHeartTimelineWindowPointCount(preset.value, pointIntervalMinutes, totalPoints),
  }));
}