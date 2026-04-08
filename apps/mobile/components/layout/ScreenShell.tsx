import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaInsetsContext, SafeAreaView } from 'react-native-safe-area-context';

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
  const insets = useContext(SafeAreaInsetsContext);
  const topInset = insets?.top ?? 0;
  const bottomInset = insets?.bottom ?? 0;
  const refreshEnabled = typeof onRefresh === 'function';
  const [activeScrollLocks, setActiveScrollLocks] = useState(0);
  const headerConfig = headerTitle && headerIcon ? { icon: headerIcon, title: headerTitle } : null;
  const hasHeader = headerConfig !== null;
  const fallbackHeaderHeight = (headerAccessory ? 118 : 72) + (hasHeader ? topInset : 0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const resolvedHeaderHeight = headerHeight === 0 ? fallbackHeaderHeight : headerHeight;
  const headerFadeHeight = resolvedHeaderHeight + 156;

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
  const contentTopPadding = hasHeader
    ? resolvedHeaderHeight + 12
    : topInset + 12;
  const contentBottomPadding = Math.max(120, bottomInset + 104);

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[colors.backgroundTop, colors.background, colors.backgroundBottom]}
        pointerEvents="none"
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[styles.glow, styles.glowTop]} />
      <View pointerEvents="none" style={[styles.glow, styles.glowBottom]} />
      <ScreenScrollContext.Provider value={screenScrollContextValue}>
        <SafeAreaView edges={['left', 'right']} style={styles.safeArea}>
          <ScrollView
            alwaysBounceVertical={refreshEnabled && activeScrollLocks === 0}
            bounces={refreshEnabled && activeScrollLocks === 0}
            contentContainerStyle={[styles.content, { paddingTop: contentTopPadding, paddingBottom: contentBottomPadding }, contentStyle]}
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
          {hasHeader ? (
            <View pointerEvents="box-none" style={styles.headerOverlay}>
              <LinearGradient
                colors={['rgba(3, 8, 14, 0.995)', 'rgba(3, 8, 14, 0.94)', 'rgba(3, 8, 14, 0.76)', 'rgba(3, 8, 14, 0.38)', 'rgba(3, 8, 14, 0.1)', 'rgba(3, 8, 14, 0)']}
                locations={[0, 0.12, 0.28, 0.5, 0.76, 1]}
                pointerEvents="none"
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
                style={[styles.headerGradient, { height: headerFadeHeight }]}
              />
              <View
                onLayout={(event) => {
                  const nextHeight = Math.ceil(event.nativeEvent.layout.height);
                  setHeaderHeight((current) => (current === nextHeight ? current : nextHeight));
                }}
                style={[styles.headerShell, { paddingTop: topInset + 8 }]}>
                <AppHeader
                  icon={headerConfig.icon}
                  settingsActive={headerSettingsActive}
                  settingsDisabled={headerSettingsDisabled}
                  title={headerConfig.title}
                />
                {headerAccessory ? <View style={styles.headerAccessory}>{headerAccessory}</View> : null}
              </View>
            </View>
          ) : null}
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
  headerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    elevation: 8,
    zIndex: 2,
  },
  headerGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  headerShell: {
    paddingHorizontal: spacing.screenPadding,
    paddingBottom: 18,
    gap: 8,
  },
  headerAccessory: {
    marginTop: 2,
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
