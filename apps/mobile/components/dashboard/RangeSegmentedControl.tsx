import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '@/constants/theme';

export function RangeSegmentedControl<T extends string>({
  options,
  selectedValue,
  onChange,
}: {
  options: Array<{ label: string; value: T }>;
  selectedValue: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.wrap}>
      {options.map((option) => {
        const selected = option.value === selectedValue;
        return (
          <Pressable
            accessibilityRole="button"
            key={option.value}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.option,
              selected ? styles.optionSelected : null,
              pressed ? styles.optionPressed : null,
            ]}>
            <Text style={[styles.optionLabel, selected ? styles.optionLabelSelected : null]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    gap: 8,
  },
  option: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    minWidth: 56,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  optionSelected: {
    backgroundColor: 'rgba(104, 255, 120, 0.16)',
    borderColor: 'rgba(104, 255, 120, 0.34)',
  },
  optionPressed: {
    opacity: 0.84,
  },
  optionLabel: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
    textAlign: 'center',
  },
  optionLabelSelected: {
    color: colors.text,
  },
});
