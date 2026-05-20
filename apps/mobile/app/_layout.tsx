import { ThemeProvider } from '@react-navigation/native';
import { Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold } from '@expo-google-fonts/manrope';
import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';

import { SleepPreparationReminderSync } from '@/components/navigation/SleepPreparationReminderSync';
import { WearableProgressOverlay } from '@/components/ui/WearableProgressOverlay';
import { navTheme } from '@/constants/theme';
import { AppDatabaseProvider } from '@/providers/AppDatabaseProvider';
import { HealthDataProvider } from '@/providers/HealthDataProvider';
import { WearableSyncProvider, useWearableSyncState } from '@/providers/WearableSyncProvider';
import { routeFromNotificationData } from '@/services/notifications/notificationRouting';

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
  return (
    <GestureHandlerRootView style={styles.root}>
      <ThemeProvider value={navTheme}>
        <AppDatabaseProvider>
          <HealthDataProvider>
            <WearableSyncProvider>
              <NotificationRouteSync />
              <StatusBar style="light" />
              <SleepPreparationReminderSync />
              <Stack>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="live-events" options={{ headerShown: false }} />
                <Stack.Screen name="+not-found" options={{ title: 'Not Found' }} />
              </Stack>
              <WearableProgressOverlay />
            </WearableSyncProvider>
          </HealthDataProvider>
        </AppDatabaseProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

function NotificationRouteSync() {
  const { isReady } = useWearableSyncState();
  const router = useRouter();
  const handledNotificationResponsesRef = useRef(new Set<string>());

  useEffect(() => {
    if (!isReady) {
      return;
    }

    let mounted = true;
    const navigationTimeouts = new Set<ReturnType<typeof setTimeout>>();

    const openNotificationRoute = (response: Notifications.NotificationResponse | null) => {
      const route = routeFromNotificationData(response?.notification.request.content.data);
      if (!route) {
        return;
      }

      const responseKey = [
        response?.notification.request.identifier ?? 'unknown',
        response?.notification.date ?? 'unknown',
        response?.actionIdentifier ?? 'unknown',
      ].join(':');

      if (handledNotificationResponsesRef.current.has(responseKey)) {
        return;
      }

      handledNotificationResponsesRef.current.add(responseKey);

      const timeout = setTimeout(() => {
        navigationTimeouts.delete(timeout);

        if (!mounted) {
          return;
        }

        router.replace(route as never);

        if (typeof Notifications.clearLastNotificationResponse === 'function') {
          Notifications.clearLastNotificationResponse();
        }
      }, 0);

      navigationTimeouts.add(timeout);
    };

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      openNotificationRoute(response);
    }).catch(() => {});

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      openNotificationRoute(response);
    });

    return () => {
      mounted = false;
      navigationTimeouts.forEach((timeout) => clearTimeout(timeout));
      navigationTimeouts.clear();
      subscription.remove();
    };
  }, [isReady, router]);

  return null;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
