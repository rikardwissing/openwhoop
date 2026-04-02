import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '@/constants/theme';

export function LoadingState({
  label,
  variant = 'screen',
}: {
  label: string;
  variant?: 'screen' | 'inline';
}) {
  return (
    <View style={variant === 'inline' ? styles.inlineWrap : styles.wrap}>
      <ActivityIndicator color={colors.primary} size={variant === 'inline' ? 'small' : 'large'} />
      <Text style={[styles.label, variant === 'inline' ? styles.inlineLabel : null]}>{label}</Text>
    </View>
  );
}

export function ErrorState({
  message,
  variant = 'screen',
}: {
  message: string;
  variant?: 'screen' | 'inline';
}) {
  return (
    <View style={variant === 'inline' ? styles.inlineWrap : styles.wrap}>
      <Text style={[styles.label, variant === 'inline' ? styles.inlineLabel : null]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 260,
    paddingHorizontal: 24,
  },
  inlineWrap: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 0,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  label: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    marginTop: 14,
    textAlign: 'center',
  },
  inlineLabel: {
    flex: 1,
    marginTop: 0,
    textAlign: 'left',
  },
});
