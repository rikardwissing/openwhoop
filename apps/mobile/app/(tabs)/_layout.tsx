import { Ionicons } from '@expo/vector-icons';
import { Image } from 'react-native';
import { Tabs } from 'expo-router';

import { PulsingHeartIcon } from '@/components/ui/PulsingHeartIcon';
import { brandMark } from '@/constants/assets';
import { colors, typography } from '@/constants/theme';
import { PairWearableScreen } from '@/screens/PairWearableScreen';
import { useWearableSyncState } from '@/providers/WearableSyncProvider';
import { hasFreshLiveHeartRate } from '@/types/device';

function TabIcon({
  color,
  focused,
  icon,
  pulseBpm,
  today,
}: {
  color: string;
  focused: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  pulseBpm?: number | null;
  today?: boolean;
}) {
  if (today) {
    return (
      <Image
        resizeMode="contain"
        source={brandMark}
        style={{
          width: focused ? 28 : 25,
          height: focused ? 28 : 25,
          opacity: focused ? 1 : 0.75,
        }}
      />
    );
  }

  if (icon === 'heart') {
    return (
      <PulsingHeartIcon
        bpm={pulseBpm ?? null}
        color={color}
        name="heart"
        size={focused ? 24 : 22}
      />
    );
  }

  return <Ionicons color={color} name={icon} size={focused ? 24 : 22} />;
}

export default function TabLayout() {
  const { deviceState, isReady } = useWearableSyncState();
  const liveHeartRate = hasFreshLiveHeartRate(deviceState) ? deviceState.liveHeartRate : null;

  if (!isReady) {
    return null;
  }

  if (!deviceState.id) {
    return <PairWearableScreen />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: 'rgba(7, 11, 19, 0.96)',
          borderTopWidth: 1,
          borderTopColor: colors.border,
          height: 88,
          paddingBottom: 12,
          paddingTop: 10,
          elevation: 0,
        },
        tabBarLabelStyle: {
          fontFamily: typography.body,
          fontSize: 11,
          marginTop: 4,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Today',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon color={color} focused={focused} icon="ellipse-outline" today />
          ),
        }}
      />
      <Tabs.Screen
        name="trends"
        options={{
          title: 'Trends',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon color={color} focused={focused} icon="stats-chart" />
          ),
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon color={color} focused={focused} icon="time" />
          ),
        }}
      />
      <Tabs.Screen
        name="sleep"
        options={{
          href: null,
          title: 'Sleep',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon color={color} focused={focused} icon="moon" />
          ),
        }}
      />
      <Tabs.Screen
        name="heart"
        options={{
          href: null,
          title: 'Heart',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon color={color} focused={focused} icon="heart" pulseBpm={liveHeartRate} />
          ),
        }}
      />
      <Tabs.Screen
        name="wellness"
        options={{
          href: null,
          title: 'Wellness',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon color={color} focused={focused} icon="pulse" />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          href: null,
          title: 'Settings',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon color={color} focused={focused} icon="settings-sharp" />
          ),
        }}
      />
    </Tabs>
  );
}
