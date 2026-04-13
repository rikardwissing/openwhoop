import { StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mapViewBoxToPixels(value: number, viewBoxSize: number, renderSize: number) {
  if (viewBoxSize <= 0 || renderSize <= 0) {
    return 0;
  }

  return (value / viewBoxSize) * renderSize;
}

export function ChartScrubOverlay({
  backgroundColor = colors.background,
  chartHeight,
  chartWidth,
  dotTestID,
  dotX,
  dotY,
  guideTestID,
  lineBottom,
  lineOpacity,
  lineTop,
  lineX,
  strokeColor,
  viewBoxHeight,
  viewBoxWidth,
}: {
  backgroundColor?: string;
  chartHeight: number;
  chartWidth: number;
  dotTestID?: string;
  dotX: number | null;
  dotY: number | null;
  guideTestID?: string;
  lineBottom: number;
  lineOpacity: number;
  lineTop: number;
  lineX: number | null;
  strokeColor: string;
  viewBoxHeight: number;
  viewBoxWidth: number;
}) {
  if (lineX === null || chartWidth <= 0 || chartHeight <= 0) {
    return null;
  }

  const lineXPx = clamp(mapViewBoxToPixels(lineX, viewBoxWidth, chartWidth), 0, chartWidth);
  const lineTopPx = clamp(mapViewBoxToPixels(lineTop, viewBoxHeight, chartHeight), 0, chartHeight);
  const lineBottomPx = clamp(mapViewBoxToPixels(lineBottom, viewBoxHeight, chartHeight), lineTopPx, chartHeight);
  const lineHeightPx = Math.max(lineBottomPx - lineTopPx, 0);
  const horizontalScale = chartWidth / Math.max(viewBoxWidth, 1);
  const outerRadius = clamp(5.6 * horizontalScale, 5.25, 9.5);
  const innerRadius = clamp(2.45 * horizontalScale, 2.4, 4.6);
  const innerBorderWidth = clamp(1 * horizontalScale, 0.9, 1.5);
  const dotXPx =
    dotX === null ? null : clamp(mapViewBoxToPixels(dotX, viewBoxWidth, chartWidth), 0, chartWidth);
  const dotYPx =
    dotY === null ? null : clamp(mapViewBoxToPixels(dotY, viewBoxHeight, chartHeight), 0, chartHeight);

  return (
    <View pointerEvents="none" style={styles.overlay}>
      {lineHeightPx > 0 ? (
        <View
          pointerEvents="none"
          style={[
            styles.guide,
            {
              borderColor: strokeColor,
              height: lineHeightPx,
              left: lineXPx,
              opacity: lineOpacity,
              top: lineTopPx,
            },
          ]}
          testID={guideTestID}
        />
      ) : null}
      {dotXPx !== null && dotYPx !== null ? (
        <>
          <View
            pointerEvents="none"
            style={[
              styles.outerDot,
              {
                backgroundColor: strokeColor,
                borderRadius: outerRadius,
                height: outerRadius * 2,
                left: dotXPx - outerRadius,
                top: dotYPx - outerRadius,
                width: outerRadius * 2,
              },
            ]}
          />
          <View
            pointerEvents="none"
            style={[
              styles.innerDot,
              {
                backgroundColor: strokeColor,
                borderColor: backgroundColor,
                borderRadius: innerRadius,
                borderWidth: innerBorderWidth,
                height: innerRadius * 2,
                left: dotXPx - innerRadius,
                top: dotYPx - innerRadius,
                width: innerRadius * 2,
              },
            ]}
            testID={dotTestID}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  guide: {
    borderLeftWidth: 1,
    borderStyle: 'dashed',
    marginLeft: -0.5,
    position: 'absolute',
  },
  outerDot: {
    opacity: 0.18,
    position: 'absolute',
  },
  innerDot: {
    position: 'absolute',
  },
});