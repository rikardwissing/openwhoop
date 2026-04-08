import type { TrendChartMarker } from '@/components/charts/TrendChart';
import { colors } from '@/constants/theme';
import type { HeartIntradayMarker } from '@/types/health';

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
  switch (marker.kind) {
    case 'sleep':
      return {
        accentColor: colors.indigo,
        backgroundColor: 'rgba(93, 120, 255, 0.14)',
      };
    case 'nap':
      return {
        accentColor: colors.aqua,
        backgroundColor: 'rgba(86, 255, 209, 0.14)',
      };
    case 'activity':
    default:
      return {
        accentColor: colors.heart,
        backgroundColor: 'rgba(255, 210, 107, 0.14)',
      };
  }
}

export interface HeartIntradayMarkerPresentation {
  iconName: TrendChartMarker['iconName'];
  accentColor: string;
  backgroundColor: string;
}

export function getHeartIntradayMarkerPresentation(marker: HeartIntradayMarker): HeartIntradayMarkerPresentation {
  const palette = paletteForHeartMarker(marker);

  return {
    iconName: iconNameForHeartMarker(marker),
    accentColor: palette.accentColor,
    backgroundColor: palette.backgroundColor,
  };
}

export function mapHeartIntradayMarkersToTrendMarkers(markers: readonly HeartIntradayMarker[]): TrendChartMarker[] {
  return markers.map((marker) => {
    const presentation = getHeartIntradayMarkerPresentation(marker);

    return {
      id: marker.id,
      iconName: presentation.iconName,
      accentColor: presentation.accentColor,
      backgroundColor: presentation.backgroundColor,
      startFraction: marker.startFraction,
      endFraction: marker.endFraction,
      accessibilityLabel: `${marker.label} ${marker.timeLabel}`,
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