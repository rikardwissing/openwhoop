import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppHeader, type AppHeaderIcon } from '@/components/layout/AppHeader';
import { colors, spacing } from '@/constants/theme';

export function ScreenShell({
  children,
  contentStyle,
  headerIcon,
  headerSettingsActive = false,
  headerSettingsDisabled = false,
  headerTitle,
  onRefresh,
  refreshing = false,
}: {
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  headerIcon?: AppHeaderIcon;
  headerSettingsActive?: boolean;
  headerSettingsDisabled?: boolean;
  headerTitle?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const refreshEnabled = typeof onRefresh === 'function';

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
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <ScrollView
          alwaysBounceVertical={refreshEnabled}
          bounces={refreshEnabled}
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
          showsVerticalScrollIndicator={false}>
          {headerTitle && headerIcon ? (
            <AppHeader
              icon={headerIcon}
              settingsActive={headerSettingsActive}
              settingsDisabled={headerSettingsDisabled}
              title={headerTitle}
            />
          ) : null}
          {children}
        </ScrollView>
      </SafeAreaView>
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
    paddingTop: 8,
    paddingBottom: 120,
    gap: spacing.sectionGap,
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
