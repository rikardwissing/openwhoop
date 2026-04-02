import { render } from '@testing-library/react-native';

import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';

describe('chart gesture ownership', () => {
  it('keeps trend scrubbing attached to the chart', () => {
    const screen = render(
      <TrendChart
        accentColor="#00ffff"
        points={[
          { label: 'Mon', value: 72 },
          { label: 'Tue', value: 76 },
          { label: 'Wed', value: 74 },
        ]}
        testID="trend-chart-overlay"
      />,
    );

    const overlay = screen.getByTestId('trend-chart-overlay');
    expect(overlay.props.onResponderTerminationRequest()).toBe(false);
  });

  it('keeps sleep-stage scrubbing attached to the chart', () => {
    const screen = render(
      <SleepStageChart
        endLabel="7:30 AM"
        middleLabel="3:00 AM"
        segments={[
          { stage: 'light', minutes: 120 },
          { stage: 'deep', minutes: 80 },
          { stage: 'rem', minutes: 95 },
        ]}
        startLabel="11:15 PM"
        testID="sleep-stage-chart-overlay"
      />,
    );

    const overlay = screen.getByTestId('sleep-stage-chart-overlay');
    expect(overlay.props.onResponderTerminationRequest()).toBe(false);
  });
});
