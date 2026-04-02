import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { brandMark } from '@/constants/assets';
import { colors, typography } from '@/constants/theme';
import { useWearableSync } from '@/providers/WearableSyncProvider';

export type AppHeaderIcon = 'today' | 'sleep' | 'heart' | 'wellness' | 'settings' | 'pair' | 'live-events';

function iconNameFor(icon: Exclude<AppHeaderIcon, 'today'>): keyof typeof Ionicons.glyphMap {
  switch (icon) {
    case 'sleep':
      return 'moon';
    case 'heart':
      return 'heart';
    case 'wellness':
      return 'pulse';
    case 'settings':
      return 'sparkles';
    case 'pair':
      return 'bluetooth';
    case 'live-events':
      return 'radio';
  }
}

function badgePalette(batteryPercent: number | null, disabled: boolean) {
  if (disabled || batteryPercent === null) {
    return {
      backgroundColor: 'rgba(112, 132, 144, 0.18)',
      borderColor: colors.border,
      textColor: colors.subtle,
    };
  }

  if (batteryPercent < 20) {
    return {
      backgroundColor: 'rgba(255, 125, 112, 0.18)',
      borderColor: 'rgba(255, 125, 112, 0.44)',
      textColor: colors.alert,
    };
  }

  if (batteryPercent < 40) {
    return {
      backgroundColor: 'rgba(200, 255, 99, 0.18)',
      borderColor: 'rgba(200, 255, 99, 0.36)',
      textColor: colors.primaryBright,
    };
  }

  return {
    backgroundColor: 'rgba(104, 255, 120, 0.18)',
    borderColor: 'rgba(104, 255, 120, 0.34)',
    textColor: colors.primary,
  };
}

export function AppHeader({
  icon,
  settingsActive = false,
  settingsDisabled = false,
  title,
}: {
  icon: AppHeaderIcon;
  settingsActive?: boolean;
  settingsDisabled?: boolean;
  title: string;
}) {
  const router = useRouter();
  const { deviceState } = useWearableSync();
  const buttonDisabled = settingsDisabled || settingsActive;
  const badgeText = deviceState.batteryPercent === null ? '--' : `${deviceState.batteryPercent}%`;
  const badgeColors = badgePalette(deviceState.batteryPercent, buttonDisabled);

  return (
    <View style={styles.row}>
      <View style={styles.titleWrap}>
        <View style={styles.iconWrap}>
          {icon === 'today' ? (
            <Image resizeMode="contain" source={brandMark} style={styles.brandMark} />
          ) : (
            <Ionicons color={colors.primary} name={iconNameFor(icon)} size={19} />
          )}
        </View>
        <Text style={styles.title}>{title}</Text>
      </View>

      <Pressable
        accessibilityLabel={settingsActive ? 'Settings open' : 'Open settings'}
        accessibilityRole="button"
        disabled={buttonDisabled}
        onPress={() => {
          router.push('/settings');
        }}
        style={({ pressed }) => [
          styles.settingsButton,
          settingsActive ? styles.settingsButtonActive : null,
          buttonDisabled && !settingsActive ? styles.settingsButtonDisabled : null,
          pressed && !buttonDisabled ? styles.settingsButtonPressed : null,
        ]}>
        <Ionicons
          color={settingsActive ? colors.primary : colors.text}
          name="settings-sharp"
          size={20}
        />
        <View
          style={[
            styles.badge,
            {
              backgroundColor: badgeColors.backgroundColor,
              borderColor: badgeColors.borderColor,
            },
          ]}>
          <Text style={[styles.badgeText, { color: badgeColors.textColor }]}>{badgeText}</Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  titleWrap: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  iconWrap: {
    alignItems: 'center',
    backgroundColor: 'rgba(8, 18, 25, 0.94)',
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  brandMark: {
    height: 28,
    width: 28,
  },
  title: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 24,
    lineHeight: 28,
  },
  settingsButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(8, 18, 25, 0.94)',
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    position: 'relative',
    width: 40,
  },
  settingsButtonActive: {
    backgroundColor: 'rgba(104, 255, 120, 0.12)',
    borderColor: 'rgba(104, 255, 120, 0.26)',
  },
  settingsButtonDisabled: {
    opacity: 0.72,
  },
  settingsButtonPressed: {
    opacity: 0.82,
  },
  badge: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    minWidth: 28,
    paddingHorizontal: 5,
    position: 'absolute',
    right: -10,
    top: -6,
  },
  badgeText: {
    fontFamily: typography.bodyBold,
    fontSize: 10,
    lineHeight: 16,
  },
});
