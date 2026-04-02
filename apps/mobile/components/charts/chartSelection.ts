import type {
  SleepStageSegment,
  SleepStageSelection,
  TrendPoint,
  TrendSelection,
} from '@/types/health';

export const TREND_VIEWBOX_WIDTH = 100;
export const TREND_VIEWBOX_BASELINE = 36;

interface TrendChartCoordinate extends TrendSelection {
  x: number;
  y: number;
}

interface SleepStageFrame extends SleepStageSelection {
  startX: number;
  width: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function buildTrendCoordinates(points: TrendPoint[]): TrendChartCoordinate[] {
  if (points.length === 0) {
    return [];
  }

  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const span = Math.max(max - min, 1);

  return points.map((point, index) => ({
    index,
    point,
    x:
      points.length === 1
        ? TREND_VIEWBOX_WIDTH / 2
        : (index / (points.length - 1)) * TREND_VIEWBOX_WIDTH,
    y: 4 + ((max - point.value) / span) * 28,
  }));
}

export function selectTrendPointAtX(
  points: TrendPoint[],
  chartWidth: number,
  touchX: number,
): TrendSelection | null {
  if (points.length === 0 || chartWidth <= 0) {
    return null;
  }

  const coordinates = buildTrendCoordinates(points);
  const targetX = clamp((touchX / chartWidth) * TREND_VIEWBOX_WIDTH, 0, TREND_VIEWBOX_WIDTH);

  const nearest = coordinates.reduce((best, current) => {
    if (!best) {
      return current;
    }

    return Math.abs(current.x - targetX) < Math.abs(best.x - targetX) ? current : best;
  }, coordinates[0] ?? null);

  return nearest
    ? {
        index: nearest.index,
        point: nearest.point,
      }
    : null;
}

export function buildSleepStageFrames(segments: SleepStageSegment[]): SleepStageFrame[] {
  const totalMinutes = segments.reduce((sum, segment) => sum + segment.minutes, 0);
  if (totalMinutes === 0) {
    return [];
  }

  let startMinute = 0;
  let startX = 0;

  return segments.map((segment, index) => {
    const endMinute = startMinute + segment.minutes;
    const width = (segment.minutes / totalMinutes) * TREND_VIEWBOX_WIDTH;
    const frame: SleepStageFrame = {
      index,
      segment,
      startMinute,
      endMinute,
      startX,
      width,
    };

    startMinute = endMinute;
    startX += width;
    return frame;
  });
}

export function selectSleepStageAtX(
  segments: SleepStageSegment[],
  chartWidth: number,
  touchX: number,
): SleepStageSelection | null {
  if (segments.length === 0 || chartWidth <= 0) {
    return null;
  }

  const frames = buildSleepStageFrames(segments);
  if (frames.length === 0) {
    return null;
  }

  const totalMinutes = frames.at(-1)?.endMinute ?? 0;
  const targetMinute = clamp((touchX / chartWidth) * totalMinutes, 0, totalMinutes);

  const selected =
    frames.find((frame, index) => {
      const isLast = index === frames.length - 1;
      return targetMinute < frame.endMinute || isLast;
    }) ?? null;

  return selected
    ? {
        index: selected.index,
        segment: selected.segment,
        startMinute: selected.startMinute,
        endMinute: selected.endMinute,
      }
    : null;
}
