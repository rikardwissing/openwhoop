import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { colors, typography } from '@/constants/theme';
import { useWearableSync } from '@/providers/WearableSyncProvider';
import type { WearableLiveEvent } from '@/types/device';
import { formatClock, formatShortDate, parseSqliteDateTime } from '@/utils/dateTime';

function sourceLabel(source: WearableLiveEvent['source']) {
  return source === 'event' ? 'Event' : 'Command';
}

function eventTimestamp(event: WearableLiveEvent) {
  const date = event.deviceUnixMs ? new Date(event.deviceUnixMs) : parseSqliteDateTime(event.observedAt);
  return `${formatShortDate(date)} · ${formatClock(date)}`;
}

export function LiveEventsScreen() {
  const router = useRouter();
  const { deviceState, liveEvents } = useWearableSync();

  return (
    <ScreenShell>
      <View>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            router.back();
          }}
          style={({ pressed }) => [
            styles.backButton,
            pressed ? styles.backButtonPressed : null,
          ]}>
          <Ionicons color={colors.primary} name="arrow-back" size={18} />
          <Text style={styles.backLabel}>Back to Settings</Text>
        </Pressable>
        <SectionHeader title="Live Events" trailing={`${liveEvents.length} seen`} />
        <Text style={styles.subtitle}>
          Meaningful wearable events and replies observed since this app session started
          {deviceState.name ? ` for ${deviceState.name}.` : '.'}
        </Text>
      </View>

      <GlassCard accentColor={colors.cyan}>
        {liveEvents.length === 0 ? (
          <Text style={styles.emptyState}>No live events seen yet in this session.</Text>
        ) : (
          liveEvents.map((event, index) => (
            <View
              key={event.id}
              style={[
                styles.eventRow,
                index < liveEvents.length - 1 ? styles.eventDivider : null,
              ]}>
              <View style={styles.eventHeader}>
                <Text style={styles.eventTitle}>{event.title}</Text>
                <Text style={styles.eventSource}>{sourceLabel(event.source)}</Text>
              </View>
              <Text style={styles.eventTime}>{eventTimestamp(event)}</Text>
              {event.detail ? <Text style={styles.eventDetail}>{event.detail}</Text> : null}
            </View>
          ))
        )}
      </GlassCard>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  backButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backButtonPressed: {
    opacity: 0.8,
  },
  backLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
  },
  subtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 6,
  },
  emptyState: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 24,
  },
  eventRow: {
    gap: 4,
    paddingVertical: 12,
  },
  eventDivider: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  eventHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  eventTitle: {
    color: colors.text,
    flex: 1,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  eventSource: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 12,
    textTransform: 'uppercase',
  },
  eventTime: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
  },
  eventDetail: {
    color: colors.text,
    fontFamily: typography.body,
    fontSize: 14,
    lineHeight: 20,
  },
});
