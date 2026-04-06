import type {
  SleepStageSegment,
  SleepStageSelection,
  TrendPoint,
  TrendSelection,
} from '@/types/health';

export const TREND_VIEWBOX_WIDTH = 100;
export const TREND_VIEWBOX_BASELINE = 36;
export const TREND_VIEWBOX_TOP = 4;
export const TREND_VIEWBOX_PLOT_BOTTOM = TREND_VIEWBOX_BASELINE - 4;

export type TrendChartMode = 'line' | 'bar';

export interface TrendDomain {
  min: number;
  max: number;
}

interface TrendChartCoordinate extends TrendSelection {
  x: number;
  y: number | null;
}

interface SleepStageFrame extends SleepStageSelection {
  startX: number;
  width: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function trendPointX(index: number, pointCount: number, mode: TrendChartMode) {
  if (pointCount === 1) {
    return TREND_VIEWBOX_WIDTH / 2;
  }

  if (mode === 'bar') {
    const slotWidth = TREND_VIEWBOX_WIDTH / pointCount;
    return slotWidth * index + slotWidth / 2;
  }

  return (index / (pointCount - 1)) * TREND_VIEWBOX_WIDTH;
}

function buildPositiveBarDomain(rawMin: number, rawMax: number): TrendDomain {
  const span = Math.max(rawMax - rawMin, 0);
  const lowerPad = Math.max(span * 1.5, rawMax * 0.08, 0.1);
  const upperPad = Math.max(span * 0.35, rawMax * 0.03, 0.1);

  return {
    min: Math.max(0, rawMin - lowerPad),
    max: rawMax + upperPad,
  };
}

function buildNegativeBarDomain(rawMin: number, rawMax: number): TrendDomain {
  const span = Math.max(rawMax - rawMin, 0);
  const lowerPad = Math.max(span * 0.35, Math.abs(rawMin) * 0.03, 0.1);

  return {
    min: rawMin - lowerPad,
    max: 0,
  };
}

function buildSignedDomain(rawMin: number, rawMax: number, paddingRatio: number): TrendDomain {
  const span = Math.max(rawMax - rawMin, 0);
  const absMax = Math.max(Math.abs(rawMin), Math.abs(rawMax), 0.1);
  const pad = Math.max(span * paddingRatio, absMax * 0.08, 0.1);
  const extent = absMax + pad;

  return {
    min: -extent,
    max: extent,
  };
}

export function buildTrendDomain(
  points: TrendPoint[],
  options?: { mode?: TrendChartMode },
): TrendDomain | null {
  const values = points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);

  if (values.length === 0) {
    return null;
  }

  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const mode = options?.mode ?? 'line';

  if (mode === 'bar') {
    if (rawMin < 0 && rawMax > 0) {
      return buildSignedDomain(rawMin, rawMax, 0.18);
    }

    if (rawMax <= 0) {
      return buildNegativeBarDomain(rawMin, rawMax);
    }

    return buildPositiveBarDomain(rawMin, rawMax);
  }

  if (rawMin < 0 && rawMax > 0) {
    return buildSignedDomain(rawMin, rawMax, 0.12);
  }

  const span = Math.max(rawMax - rawMin, 0);
  const magnitude = Math.max(Math.abs(rawMin), Math.abs(rawMax), 1);
  const pad = Math.max(span * 0.18, magnitude * 0.05, 0.1);

  return {
    min: rawMin - pad,
    max: rawMax + pad,
  };
}

export function mapTrendValueToY(value: number, domain: TrendDomain): number {
  const span = Math.max(domain.max - domain.min, 0.0001);

  return TREND_VIEWBOX_TOP + ((domain.max - value) / span) * (TREND_VIEWBOX_PLOT_BOTTOM - TREND_VIEWBOX_TOP);
}

export function buildTrendCoordinates(
  points: TrendPoint[],
  options?: { mode?: TrendChartMode; domain?: TrendDomain | null },
): TrendChartCoordinate[] {
  if (points.length === 0) {
    return [];
  }

  const mode = options?.mode ?? 'line';
  const domain = options?.domain ?? buildTrendDomain(points, options);

  if (!domain) {
    return points.map((point, index) => ({
      index,
      point,
      x: trendPointX(index, points.length, mode),
      y: null,
    }));
  }

  return points.map((point, index) => ({
    index,
    point,
    x: trendPointX(index, points.length, mode),
    y: point.value === null ? null : mapTrendValueToY(point.value, domain),
  }));
}

export function selectTrendPointAtX(
  points: TrendPoint[],
  chartWidth: number,
  touchX: number,
  options?: { mode?: TrendChartMode },
): TrendSelection | null {
  if (points.length === 0 || chartWidth <= 0) {
    return null;
  }

  const coordinates = buildTrendCoordinates(points, options);
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
