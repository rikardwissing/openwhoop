import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('expo-router', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Tabs = Object.assign(
    ({ children }: { children: ReactNode }) => <>{children}</>,
    {
      Screen: ({ name, options }: { name: string; options?: { title?: string } }) => (
        <Text testID={`tab-${name}`}>{options?.title ?? name}</Text>
      ),
    },
  );

  return {
    __esModule: true,
    Tabs,
    useRouter: () => ({
      push: jest.fn(),
      replace: jest.fn(),
      back: jest.fn(),
    }),
  };
});

import TabLayout from '../app/(tabs)/_layout';
import {
  WearableSyncContextProvider,
  defaultWearableSyncContextValue,
} from '@/providers/WearableSyncProvider';
import type { DeviceState } from '@/types/device';

function renderTabLayout(overrides: Partial<{
  isReady: boolean;
  deviceState: DeviceState;
}> = {}) {
  return render(
    <WearableSyncContextProvider
      value={{
        ...defaultWearableSyncContextValue,
        ...overrides,
        deviceState: {
          ...defaultWearableSyncContextValue.deviceState,
          ...overrides.deviceState,
        },
      }}>
      <TabLayout />
    </WearableSyncContextProvider>,
  );
}

describe('TabLayout', () => {
  it('shows the pairing screen instead of tabs when no device is paired', () => {
    const screen = renderTabLayout({
      isReady: true,
    });

    expect(screen.getByText('Pair Wearable')).toBeTruthy();
    expect(screen.queryByTestId('tab-index')).toBeNull();
  });

  it('shows the tabs once a wearable is paired', () => {
    const screen = renderTabLayout({
      isReady: true,
      deviceState: {
        ...defaultWearableSyncContextValue.deviceState,
        id: 'strap-1',
        name: 'Neo Strap',
      },
    });

    expect(screen.getByTestId('tab-index')).toBeTruthy();
    expect(screen.getByTestId('tab-trends')).toBeTruthy();
    expect(screen.getByTestId('tab-history')).toBeTruthy();
  });
});