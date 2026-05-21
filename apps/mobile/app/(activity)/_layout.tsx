import { Stack } from 'expo-router';

export default function ActivityLayout() {
  return (
    <Stack
      screenOptions={{
        animation: 'fade',
        contentStyle: { backgroundColor: '#02060d' },
        headerShown: false,
      }}>
      <Stack.Screen name="activity-in-progress" />
      <Stack.Screen name="activity-stop" />
    </Stack>
  );
}
