import { Image, StyleSheet, Switch, Text, View } from 'react-native';

import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { StatChip } from '@/components/ui/StatChip';
import { appIcon } from '@/constants/assets';
import { colors, typography } from '@/constants/theme';

const placeholders = ['Connect wearable', 'Sync history', 'Import local data'];

export function SettingsScreen() {
  return (
    <ScreenShell>
      <View>
        <SectionHeader title="Settings" trailing="Prototype shell" />
        <Text style={styles.subtitle}>The local-only foundation for the future BLE app.</Text>
      </View>

      <GlassCard accentColor={colors.primary}>
        <View style={styles.profileRow}>
          <Image source={appIcon} style={styles.profileIcon} />
          <View style={styles.profileText}>
            <Text style={styles.profileTitle}>BtWearable</Text>
            <Text style={styles.profileSubtitle}>Neon offline prototype · SDK 55</Text>
          </View>
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.cyan}>
        <SectionHeader title="Appearance" trailing="Locked for v1" />
        <View style={styles.settingRow}>
          <View>
            <Text style={styles.settingTitle}>Dark theme</Text>
            <Text style={styles.settingSubtitle}>This prototype is intentionally dark-only.</Text>
          </View>
          <Switch disabled trackColor={{ false: colors.border, true: colors.primary }} value />
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.success}>
        <SectionHeader title="Future Device Actions" trailing="Disabled" />
        {placeholders.map((label, index) => (
          <View key={label} style={[styles.settingRow, index < placeholders.length - 1 ? styles.divider : null]}>
            <View>
              <Text style={styles.settingTitle}>{label}</Text>
              <Text style={styles.settingSubtitle}>Planned for the local BLE + SQLite phase.</Text>
            </View>
            <StatChip accent={colors.borderStrong} label="Status" value="Soon" />
          </View>
        ))}
      </GlassCard>

      <GlassCard accentColor={colors.violet}>
        <SectionHeader title="Roadmap" trailing="Next phase" />
        <Text style={styles.roadmapText}>
          Replace mock repositories with on-device SQLite, then add BLE transport in an Expo development
          build for real wearable sync on a physical iPhone.
        </Text>
      </GlassCard>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    marginTop: 6,
  },
  profileRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  profileIcon: {
    height: 56,
    width: 56,
  },
  profileText: {
    flex: 1,
  },
  profileTitle: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 24,
  },
  profileSubtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    marginTop: 4,
  },
  settingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  divider: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  settingTitle: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  settingSubtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 4,
  },
  roadmapText: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 24,
  },
});
