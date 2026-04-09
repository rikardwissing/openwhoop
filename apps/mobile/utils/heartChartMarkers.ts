import type { TrendChartMarker } from '@/components/charts/TrendChart';
import { colors } from '@/constants/theme';
import type { HeartIntradayMarker } from '@/types/health';

export type HeartIntradayMarkerTrustState = 'suggested' | 'trusted';

function withAlpha(hexColor: string, alpha: number) {
  const normalized = hexColor.replace('#', '');

  if (normalized.length !== 6) {
    return hexColor;
  }

  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function iconNameForHeartMarker(marker: HeartIntradayMarker): TrendChartMarker['iconName'] {
  if (marker.kind === 'sleep') {
    return 'moon';
  }

  if (marker.kind === 'nap') {
    return 'time-outline';
  }

  const normalizedLabel = marker.label.toLowerCase();
  if (normalizedLabel.includes('walk') || normalizedLabel.includes('run')) {
    return 'walk';
  }

  if (
    normalizedLabel.includes('mobility') ||
    normalizedLabel.includes('strength') ||
    normalizedLabel.includes('lift') ||
    normalizedLabel.includes('workout')
  ) {
    return 'barbell';
  }

  return 'pulse';
}

function paletteForHeartMarker(marker: HeartIntradayMarker) {
  const trustState = getHeartIntradayMarkerTrustState(marker);
  const isSuggested = trustState === 'suggested';

  switch (marker.kind) {
    case 'sleep':
      return {
        accentColor: colors.indigo,
        backgroundColor: 'rgba(93, 120, 255, 0.14)',
        badgeOpacity: 1,
      };
    case 'nap':
      return {
        accentColor: colors.aqua,
        backgroundColor: isSuggested ? withAlpha(colors.aqua, 0.08) : withAlpha(colors.aqua, 0.14),
        badgeOpacity: isSuggested ? 0.56 : 1,
      };
    case 'activity':
    default:
      return {
        accentColor: colors.heart,
        backgroundColor: isSuggested ? withAlpha(colors.heart, 0.08) : withAlpha(colors.heart, 0.14),
        badgeOpacity: isSuggested ? 0.56 : 1,
      };
  }
}

export interface HeartIntradayMarkerPresentation {
  iconName: TrendChartMarker['iconName'];
  accentColor: string;
  backgroundColor: string;
  badgeOpacity: number;
}

export function getHeartIntradayMarkerTrustState(
  marker: HeartIntradayMarker,
): HeartIntradayMarkerTrustState | null {
  if (marker.kind === 'sleep') {
    return null;
  }

  if (marker.details?.source === 'detected' && marker.details.reviewState === 'none') {
    return 'suggested';
  }

  if (marker.details?.source === 'manual') {
    return 'trusted';
  }

  if (marker.details?.reviewState === 'confirmed' || marker.details?.reviewState === 'relabelled') {
    return 'trusted';
  }

  return null;
}

export function getHeartIntradayMarkerReviewLabel(marker: HeartIntradayMarker): string | null {
  if (marker.kind === 'sleep') {
    return null;
  }

  if (marker.details?.source === 'manual') {
    return 'Manual';
  }

  switch (marker.details?.reviewState) {
    case 'confirmed':
      return 'Confirmed';
    case 'relabelled':
      return 'Relabelled';
    case 'none':
      return marker.details?.source === 'detected' ? 'Suggested' : null;
    default:
      return null;
  }
}

export function canManageHeartIntradayMarker(marker: HeartIntradayMarker) {
  return getHeartIntradayMarkerTrustState(marker) === 'suggested';
}

export function getHeartIntradayMarkerPresentation(marker: HeartIntradayMarker): HeartIntradayMarkerPresentation {
  const palette = paletteForHeartMarker(marker);

  return {
    iconName: iconNameForHeartMarker(marker),
    accentColor: palette.accentColor,
    backgroundColor: palette.backgroundColor,
    badgeOpacity: palette.badgeOpacity,
  };
}

export function mapHeartIntradayMarkersToTrendMarkers(markers: readonly HeartIntradayMarker[]): TrendChartMarker[] {
  return markers.map((marker) => {
    const presentation = getHeartIntradayMarkerPresentation(marker);
    const reviewLabel = getHeartIntradayMarkerReviewLabel(marker);

    return {
      id: marker.id,
      iconName: presentation.iconName,
      accentColor: presentation.accentColor,
      backgroundColor: presentation.backgroundColor,
      startFraction: marker.startFraction,
      endFraction: marker.endFraction,
      accessibilityLabel: reviewLabel ? `${reviewLabel} ${marker.label} ${marker.timeLabel}` : `${marker.label} ${marker.timeLabel}`,
    } satisfies TrendChartMarker;
  });
}

export function describeHeartIntradayMarkers(markers: readonly HeartIntradayMarker[]) {
  if (markers.length === 0) {
    return null;
  }

  const kinds = new Set(markers.map((marker) => marker.kind));
  if (kinds.has('nap')) {
    return 'Icons mark sleep, naps, and activity windows.';
  }

  if (kinds.has('activity')) {
    return 'Icons mark sleep and activity windows.';
  }

  return 'Icons mark recent sleep windows.';
}