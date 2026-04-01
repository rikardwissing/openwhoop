import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { GlowRing } from '@/components/ui/GlowRing';
import { MetricCard } from '@/components/ui/MetricCard';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { colors, typography } from '@/constants/theme';
import { useSleepHistory } from '@/hooks/useHealthData';
import { formatCompactDuration, formatDuration } from '@/utils/formatters';

export function SleepScreen() {
  const state = useSleepHistory('14d');

  if (state.status === 'loading') {
    return (
      <ScreenShell>
        <LoadingState label="Loading sleep score and stage history..." />
      </ScreenShell>
    );
  }

  if (state.status === 'error') {
    return (
      <ScreenShell>
        <ErrorState message="Unable to load sleep history right now." />
      </ScreenShell>
    );
  }

  const data = state.data;
  const latestSession = data.sessions[0];

  return (
    <ScreenShell>
      <View>
        <SectionHeader title="Sleep" trailing="Last 14 nights" />
        <Text style={styles.subtitle}>Rhythm, recovery, and stage balance.</Text>
      </View>

      <GlowRing caption="Sleep Score" label={data.headlineLabel} score={data.headlineScore} size={238} />

      <View style={styles.metricGrid}>
        <MetricCard
          accentColor={colors.violet}
          style={styles.metricCard}
          subtitle={`${data.bedtime} to ${data.wakeTime}`}
          title="Time Asleep"
          value={formatCompactDuration(data.durationMinutes)}
        />
        <MetricCard
          accentColor={colors.aqua}
          style={styles.metricCard}
          subtitle={`Wake consistency ${data.wakeConsistency}%`}
          title="Bedtime Rhythm"
          value={`${data.bedtimeConsistency}%`}
        />
      </View>

      <GlassCard accentColor={colors.violet}>
        <SectionHeader title="Sleep Score Trend" trailing="14 day rhythm" />
        <TrendChart accentColor={colors.violet} points={data.scoreTrend} />
      </GlassCard>

      <GlassCard accentColor={colors.aqua}>
        <SectionHeader title="Duration Trend" trailing="Hours slept" />
        <TrendChart accentColor={colors.aqua} points={data.durationTrend} />
        <Text style={styles.footnote}>Latest duration: {formatDuration(data.durationMinutes)}</Text>
      </GlassCard>

      <GlassCard accentColor={colors.indigo}>
        <SectionHeader title="Last Night Stages" trailing={latestSession.dateLabel} />
        <SleepStageChart
          endLabel={latestSession.wakeTime}
          middleLabel="3:00 AM"
          segments={latestSession.stages}
          startLabel={latestSession.bedtime}
        />
        <View style={styles.sessionStats}>
          <Text style={styles.sessionStat}>Efficiency {latestSession.efficiency}%</Text>
          <Text style={styles.sessionStat}>REM {latestSession.remMinutes}m</Text>
          <Text style={styles.sessionStat}>Deep {latestSession.deepMinutes}m</Text>
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.success}>
        <SectionHeader title="Recent Nights" trailing="Most recent sessions" />
        {data.sessions.map((session, index) => (
          <View key={session.id} style={[styles.sessionRow, index < data.sessions.length - 1 ? styles.sessionDivider : null]}>
            <View>
              <Text style={styles.sessionDate}>{session.dateLabel}</Text>
              <Text style={styles.sessionTime}>
                {session.bedtime} to {session.wakeTime}
              </Text>
            </View>
            <View style={styles.sessionMeta}>
              <Text style={styles.sessionScore}>{session.score}</Text>
              <Ionicons color={colors.success} name="moon" size={16} />
            </View>
          </View>
        ))}
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
  metricGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  metricCard: {
    flex: 1,
  },
  footnote: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 8,
  },
  sessionStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  sessionStat: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  sessionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  sessionDivider: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  sessionDate: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  sessionTime: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 4,
  },
  sessionMeta: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  sessionScore: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 24,
  },
});
