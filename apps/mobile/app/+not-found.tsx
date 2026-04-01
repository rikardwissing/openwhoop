import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '@/constants/theme';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Missing Screen' }} />
      <View style={styles.container}>
        <Text style={styles.title}>This route does not exist.</Text>
        <Text style={styles.subtitle}>
          The neon prototype only ships the five main wellness tabs for now.
        </Text>
        <Link href="/" style={styles.link}>
          <Text style={styles.linkText}>Back to Today</Text>
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: 24,
  },
  title: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 28,
    marginBottom: 12,
  },
  subtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 22,
  },
  link: {
    marginTop: 24,
  },
  linkText: {
    color: colors.primary,
    fontFamily: typography.bodySemiBold,
    fontSize: 16,
  },
});
