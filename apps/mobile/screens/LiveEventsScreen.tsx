import { StyleSheet, Text, View } from 'react-native';

import { ScreenShell } from '@/components/layout/ScreenShell';
import { GlassCard } from '@/components/ui/GlassCard';
import { colors, typography } from '@/constants/theme';
import { useWearableLiveEvents, useWearableSyncState } from '@/providers/WearableSyncProvider';
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
  const { deviceState } = useWearableSyncState();
  const { liveEvents } = useWearableLiveEvents();

  return (
    <ScreenShell headerIcon="live-events" headerTitle="Live Events">
      <View>
        <Text style={styles.subtitle}>
          Meaningful wearable events and replies observed since this app session started
          {deviceState.name ? ` for ${deviceState.name}.` : '.'}
        </Text>
        <Text style={styles.meta}>{liveEvents.length} seen in this app session</Text>
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
  subtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 22,
  },
  meta: {
    color: colors.subtle,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
    marginTop: 8,
    textTransform: 'uppercase',
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
