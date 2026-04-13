export const HEART_TIMELINE_POINT_INTERVAL_MINUTES = 5;

export const HEART_TIMELINE_ZOOM_PRESETS = [
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
    label: '7D',
    latestLabel: 'Last 7d',
    value: '7d',
    windowMinutes: 7 * 24 * 60,
  },
] as const;

export type HeartTimelineZoomLevel = (typeof HEART_TIMELINE_ZOOM_PRESETS)[number]['value'];

export function getHeartTimelineZoomPreset(zoomLevel: HeartTimelineZoomLevel) {
  return HEART_TIMELINE_ZOOM_PRESETS.find((preset) => preset.value === zoomLevel) ?? HEART_TIMELINE_ZOOM_PRESETS[0];
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