import { StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '@/constants/theme';

export function SectionHeader({
  title,
  trailing,
}: {
  title: string;
  trailing?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      {trailing ? <Text style={styles.trailing}>{trailing}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  title: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 22,
  },
  trailing: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
  },
});
