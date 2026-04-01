import type { ReactElement } from 'react';
import { render } from '@testing-library/react-native';

import { MockHealthRepository } from '@/data/mock/MockHealthRepository';
import { HealthDataProvider } from '@/providers/HealthDataProvider';
import { HeartScreen } from '@/screens/HeartScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { SleepScreen } from '@/screens/SleepScreen';
import { TodayScreen } from '@/screens/TodayScreen';
import { WellnessScreen } from '@/screens/WellnessScreen';

function renderWithProviders(children: ReactElement) {
  return render(
    <HealthDataProvider repository={new MockHealthRepository({ delayMs: 0 })}>
      {children}
    </HealthDataProvider>
  );
}

describe('screen rendering', () => {
  it('renders the today screen dashboard', async () => {
    const screen = renderWithProviders(<TodayScreen />);

    expect(await screen.findByText('Good afternoon')).toBeTruthy();
    expect(await screen.findByText('Heart Rate')).toBeTruthy();
    expect(await screen.findByText('Strain')).toBeTruthy();
  });

  it('renders the sleep screen', async () => {
    const screen = renderWithProviders(<SleepScreen />);

    expect(await screen.findByText('Sleep Score Trend')).toBeTruthy();
    expect(await screen.findByText('Recent Nights')).toBeTruthy();
  });

  it('renders the heart screen', async () => {
    const screen = renderWithProviders(<HeartScreen />);

    expect(await screen.findByText('Intraday Heart Rate')).toBeTruthy();
    expect(await screen.findByText('Resting HR Trend')).toBeTruthy();
  });

  it('renders the wellness screen', async () => {
    const screen = renderWithProviders(<WellnessScreen />);

    expect(await screen.findByText('Stress')).toBeTruthy();
    expect(await screen.findByText('Recent Activity')).toBeTruthy();
  });

  it('renders the settings screen placeholders', () => {
    const screen = renderWithProviders(<SettingsScreen />);

    expect(screen.getByText('Future Device Actions')).toBeTruthy();
    expect(screen.getByText('Connect wearable')).toBeTruthy();
  });
});
