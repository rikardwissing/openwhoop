import { ThemeProvider } from '@react-navigation/native';
import { Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold } from '@expo-google-fonts/manrope';
import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';

import { SleepPreparationReminderSync } from '@/components/navigation/SleepPreparationReminderSync';
import { WearablePairingGate } from '@/components/navigation/WearablePairingGate';
import { WearableProgressOverlay } from '@/components/ui/WearableProgressOverlay';
import { navTheme } from '@/constants/theme';
import { AppDatabaseProvider } from '@/providers/AppDatabaseProvider';
import { HealthDataProvider } from '@/providers/HealthDataProvider';
import { WearableSyncProvider } from '@/providers/WearableSyncProvider';
import { routeFromNotificationData } from '@/services/background/backgroundSyncNotifications';
import '@/services/background/backgroundSyncTask';

export {
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    ManropeMedium: Manrope_500Medium,
    ManropeSemiBold: Manrope_600SemiBold,
    ManropeBold: Manrope_700Bold,
    SpaceGroteskMedium: SpaceGrotesk_500Medium,
    SpaceGroteskBold: SpaceGrotesk_700Bold,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return <RootLayoutNav />;
}

function RootLayoutNav() {
  const router = useRouter();

  useEffect(() => {
    let mounted = true;

    const openNotificationRoute = (route: string | null) => {
      if (mounted && route) {
        router.push(route as never);
      }
    };

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      openNotificationRoute(routeFromNotificationData(response?.notification.request.content.data));
    });

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      openNotificationRoute(routeFromNotificationData(response.notification.request.content.data));
    });

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [router]);

  return (
    <ThemeProvider value={navTheme}>
      <AppDatabaseProvider>
        <HealthDataProvider>
          <WearableSyncProvider>
            <StatusBar style="light" />
            <SleepPreparationReminderSync />
            <Stack>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="live-events" options={{ headerShown: false }} />
              <Stack.Screen name="pair-wearable" options={{ headerShown: false }} />
              <Stack.Screen name="+not-found" options={{ title: 'Not Found' }} />
            </Stack>
            <WearablePairingGate />
            <WearableProgressOverlay />
          </WearableSyncProvider>
        </HealthDataProvider>
      </AppDatabaseProvider>
    </ThemeProvider>
  );
}
