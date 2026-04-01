import { Ionicons } from '@expo/vector-icons';
import { Image } from 'react-native';
import { Tabs } from 'expo-router';

import { appIcon } from '@/constants/assets';
import { colors, typography } from '@/constants/theme';

function TabIcon({
  color,
  focused,
  icon,
  today,
}: {
  color: string;
  focused: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  today?: boolean;
}) {
  if (today) {
    return (
      <Image
        source={appIcon}
        style={{
          width: focused ? 24 : 22,
          height: focused ? 24 : 22,
          opacity: focused ? 1 : 0.75,
        }}
      />
    );
  }

  return <Ionicons color={color} name={icon} size={focused ? 24 : 22} />;
}

export default function TabLayout() {
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
        name="sleep"
        options={{
          title: 'Sleep',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon color={color} focused={focused} icon="moon" />
          ),
        }}
      />
      <Tabs.Screen
        name="heart"
        options={{
          title: 'Heart',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon color={color} focused={focused} icon="heart" />
          ),
        }}
      />
      <Tabs.Screen
        name="wellness"
        options={{
          title: 'Wellness',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon color={color} focused={focused} icon="pulse" />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon color={color} focused={focused} icon="settings-sharp" />
          ),
        }}
      />
    </Tabs>
  );
}
