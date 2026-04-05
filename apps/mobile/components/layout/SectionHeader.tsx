import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '@/constants/theme';

export function SectionHeader({
  title,
  trailing,
  titleNumberOfLines,
}: {
  title: string;
  trailing?: ReactNode;
  titleNumberOfLines?: number;
}) {
  return (
    <View style={styles.row}>
      <Text numberOfLines={titleNumberOfLines} style={styles.title}>
        {title}
      </Text>
      {typeof trailing === 'string' ? (
        <Text numberOfLines={1} style={styles.trailing}>
          {trailing}
        </Text>
      ) : (
        trailing ?? null
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 2,
    minWidth: 0,
  },
  title: {
    color: colors.text,
    flex: 1,
    flexShrink: 1,
    fontFamily: typography.headingMedium,
    fontSize: 22,
    lineHeight: 26,
    minWidth: 0,
  },
  trailing: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 16,
  },
});
