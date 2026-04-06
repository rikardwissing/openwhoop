import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppHeader, type AppHeaderIcon } from '@/components/layout/AppHeader';
import { ScreenScrollContext } from '@/components/layout/ScreenScrollContext';
import { colors, spacing } from '@/constants/theme';

export function ScreenShell({
  children,
  contentStyle,
  headerAccessory,
  headerIcon,
  headerSettingsActive = false,
  headerSettingsDisabled = false,
  headerTitle,
  onRefresh,
  refreshing = false,
}: {
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  headerAccessory?: ReactNode;
  headerIcon?: AppHeaderIcon;
  headerSettingsActive?: boolean;
  headerSettingsDisabled?: boolean;
  headerTitle?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const refreshEnabled = typeof onRefresh === 'function';
  const [activeScrollLocks, setActiveScrollLocks] = useState(0);

  const acquireScrollLock = useCallback(() => {
    let released = false;
    setActiveScrollLocks((current) => current + 1);

    return () => {
      if (released) {
        return;
      }

      released = true;
      setActiveScrollLocks((current) => Math.max(0, current - 1));
    };
  }, []);

  const screenScrollContextValue = useMemo(() => acquireScrollLock, [acquireScrollLock]);

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[colors.backgroundTop, colors.background, colors.backgroundBottom]}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.glow, styles.glowTop]} />
      <View style={[styles.glow, styles.glowBottom]} />
      <ScreenScrollContext.Provider value={screenScrollContextValue}>
        <SafeAreaView edges={['top']} style={styles.safeArea}>
          {headerTitle && headerIcon ? (
            <View style={styles.headerShell}>
              <AppHeader
                icon={headerIcon}
                settingsActive={headerSettingsActive}
                settingsDisabled={headerSettingsDisabled}
                title={headerTitle}
              />
              {headerAccessory ? <View style={styles.headerAccessory}>{headerAccessory}</View> : null}
            </View>
          ) : null}
          <ScrollView
            alwaysBounceVertical={refreshEnabled && activeScrollLocks === 0}
            bounces={refreshEnabled && activeScrollLocks === 0}
            contentContainerStyle={[styles.content, contentStyle]}
            refreshControl={
              refreshEnabled ? (
                <RefreshControl
                  onRefresh={onRefresh}
                  progressBackgroundColor="rgba(18, 28, 42, 0.92)"
                  refreshing={refreshing}
                  tintColor={colors.primary}
                />
              ) : undefined
            }
            scrollEnabled={activeScrollLocks === 0}
            showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </SafeAreaView>
      </ScreenScrollContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing.screenPadding,
    paddingTop: 12,
    paddingBottom: 120,
    gap: spacing.sectionGap,
  },
  headerShell: {
    paddingHorizontal: spacing.screenPadding,
    paddingTop: 8,
    paddingBottom: 14,
    gap: 8,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(3, 8, 14, 0.94)',
  },
  headerAccessory: {
    marginTop: 0,
  },
  glow: {
    position: 'absolute',
    borderRadius: 220,
  },
  glowTop: {
    top: 32,
    left: 96,
    width: 260,
    height: 260,
    backgroundColor: 'rgba(78, 255, 210, 0.09)',
  },
  glowBottom: {
    bottom: 140,
    right: -30,
    width: 240,
    height: 240,
    backgroundColor: 'rgba(114, 255, 107, 0.07)',
  },
});
