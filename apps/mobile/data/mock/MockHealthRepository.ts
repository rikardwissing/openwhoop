import type {
  ActivityRescanResult,
  HealthRepository,
  ManualActivityKind,
} from '@/data/HealthRepository';
import type {
  DerivedRefreshState,
  ActivitySummary,
  ActivityReviewState,
  ActivitySource,
  DashboardDayOption,
  DashboardDayState,
  DashboardInsight,
  FocusedHeartDetail,
  HeartCardData,
  HeartIntradayMarker,
  HeartHistoryData,
  HistoryOverview,
  HeartTimelineSample,
  HeartTimelineWindow,
  HistoryRange,
  MetricSeries,
  SleepHistoryData,
  SleepPlan,
  SleepSession,
  TodayOverview,
  TrendMetric,
  TrendPoint,
  TrendData,
  WellnessData,
} from '@/types/health';
import { formatAxisTime, formatClockMinutes } from '@/utils/dateTime';
import { describeRecovery } from '@/utils/formatters';
import { sustainedPeakBpm } from '@/utils/heartRate';
import { buildHeartCardDataFromWindow } from '@/utils/heartTimeline';
import {
  ALARM_WEEKDAY_FULL_MASK,
  BASE_SLEEP_NEED_MINUTES,
  calculateOptimalBedtimeMinutes,
  calculateSleepDebtMinutes,
  nextAlarmTargetDate,
  normalizeAlarmScheduleKind,
  normalizeAlarmWakeMode,
  normalizeAlarmWeekdayMask,
  roundClockMinutes,
  type AlarmSettingsInput,
} from '@/utils/sleepPlan';

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function series(labels: string[], values: number[]): TrendPoint[] {
  return labels.map((label, index) => ({
    label,
    value: values[index] ?? values.at(-1) ?? 0,
  }));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function gaussian(minuteOfDay: number, center: number, width: number, amplitude: number) {
  return amplitude * Math.exp(-((minuteOfDay - center) ** 2) / (2 * width ** 2));
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function average(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length === 0 ? null : mean(valid);
}

function heartRateForTime(time: Date) {
  const minuteOfDay = time.getHours() * 60 + time.getMinutes();
  const circadianBaseline = 68 + Math.sin((minuteOfDay / (24 * 60)) * Math.PI * 2 - Math.PI / 2) * 7;
  const morningRise = gaussian(minuteOfDay, 420, 70, 18);
  const middayPush = gaussian(minuteOfDay, 780, 45, 96);
  const eveningWalk = gaussian(minuteOfDay, 1110, 70, 20);
  const overnightDip = gaussian(minuteOfDay, 180, 80, 11);

  return Math.round(clamp(circadianBaseline + morningRise + middayPush + eveningWalk - overnightDip, 52, 172));
}

function buildIntradayHeartSeries(
  stepMinutes: number,
  startDate = new Date(2026, 3, 23, 0, 0, 0, 0),
  pointCount = (24 * 60) / stepMinutes,
): TrendPoint[] {

  return Array.from({ length: pointCount }, (_, index) => {
    const time = new Date(startDate.getTime() + index * stepMinutes * 60000);

    return {
      label: formatAxisTime(time, { includeSeconds: stepMinutes < 1 }),
      value: heartRateForTime(time),
    };
  });
}

function buildHeartTimelineSamples(
  stepMinutes: number,
  startDate = new Date(2026, 3, 23, 0, 0, 0, 0),
  pointCount = (24 * 60) / stepMinutes,
): HeartTimelineSample[] {
  return Array.from({ length: pointCount }, (_, index) => {
    const date = new Date(startDate.getTime() + index * stepMinutes * 60000);

    return {
      date,
      bpm: heartRateForTime(date),
    };
  });
}

function rangeLength(range: HistoryRange): number {
  switch (range) {
    case '24h':
      return 12;
    case '7d':
      return 7;
    case '14d':
      return 14;
    case '30d':
      return 14;
  }
}

function rangeHours(range: HistoryRange): number {
  switch (range) {
    case '24h':
      return 24;
    case '7d':
      return 7 * 24;
    case '14d':
      return 14 * 24;
    case '30d':
      return 30 * 24;
  }
}

function takeTail<T>(items: T[], range: HistoryRange): T[] {
  return items.slice(-rangeLength(range));
}

function fractionOfWindow(date: Date, windowStart: Date, windowEnd: Date) {
  const totalWindowMs = Math.max(1, windowEnd.getTime() - windowStart.getTime());
  return clamp((date.getTime() - windowStart.getTime()) / totalWindowMs, 0, 1);
}

const intradayHeartSeries = buildIntradayHeartSeries(5);
const dashboardHeartSeries = intradayHeartSeries;
const todayDashboardHeartWindowStart = new Date(2026, 3, 22, 19, 45, 0, 0);
const todayDashboardHeartWindowEnd = new Date(2026, 3, 23, 7, 45, 0, 0);
const todayDashboardHeartSeries = buildIntradayHeartSeries(
  5,
  todayDashboardHeartWindowStart,
  (12 * 60) / 5 + 1,
);
const intradayValues = intradayHeartSeries
  .map((point) => point.value)
  .filter((value): value is number => value !== null);
const todayDashboardHeartValues = todayDashboardHeartSeries
  .map((point) => point.value)
  .filter((value): value is number => value !== null);
const intradayAverageHr = Math.round(mean(intradayValues));
const intradayMaxHr = sustainedPeakBpm(intradayValues) ?? Math.max(...intradayValues);
const todayDashboardAverageHr = Math.round(mean(todayDashboardHeartValues));
const todayDashboardMaxHr = sustainedPeakBpm(todayDashboardHeartValues) ?? Math.max(...todayDashboardHeartValues);
const strainValues = [4.4, 4.8, 5.2, 6.1, 6.8, 7.2, 7.6, 8.1, 9.4, 10.8, 9.9, 10.1, 10.9, 11];
const scoreLabels = ['Apr 10', 'Apr 11', 'Apr 12', 'Apr 13', 'Apr 14', 'Apr 15', 'Apr 16', 'Apr 17', 'Apr 18', 'Apr 19', 'Apr 20', 'Apr 21', 'Apr 22', 'Apr 23'];
const sleepScores = [71, 76, 74, 79, 82, 77, 81, 84, 80, 83, 78, 82, 86, 82];
const sleepDurations = [404, 421, 438, 455, 463, 444, 458, 470, 452, 476, 447, 465, 479, 465];
const sleepDurationHours = sleepDurations.map((value) => Number((value / 60).toFixed(1)));
const sleepConsistencyTrend = [78, 79, 80, 82, 83, 82, 84, 85, 83, 84, 85, 87, 89, 88];
const restingHrTrend = [53, 52, 51, 50, 50, 49, 49, 48, 48, 47, 48, 49, 48, 48];
const hrvTrend = [71, 74, 69, 72, 77, 75, 78, 81, 76, 79, 74, 78, 84, 82];
const stressTrend = [42, 39, 37, 34, 33, 32, 31, 31, 30, 29, 30, 29, 28, 29];
const spo2Trend = [95, 96, 96, 97, 96, 97, 97, 96, 96, 97, 97, 96, 97, 97];
const skinTemperatureTrend = [33.2, 33.1, 33.3, 33.4, 33.5, 33.6, 33.6, 33.4, 33.5, 33.6, 33.7, 33.7, 33.8, 33.8];
const skinTemperatureDeviationTrend = [-0.2, -0.3, -0.2, -0.1, 0, 0.1, 0.1, -0.1, 0, 0.1, 0.2, 0.2, 0.3, 0.2];
const recoveryTrendValues = [75, 77, 73, 71, 74, 72, 69, 70, 72, 68, 66, 65, 64, 64];
const dayMetricLabels = ['12A', '3A', '6A', '9A', '12P', '3P', '6P', '9P'];
const overnightMetricLabels = ['11P', '12A', '1A', '2A', '3A', '4A', '5A', '6A', '7A'];
const hrvOvernightSeries = [74, 76, 78, 80, 82, 83, 84, 82, 80];
const stressDaySeries = [36, 31, 28, 32, 35, 33, 30, 27];
const spo2OvernightSeries = [95, 96, 97, 97, 96, 97, 97, 96, 97];
const skinTemperatureOvernightSeries = [33.1, 33.2, 33.3, 33.4, 33.6, 33.7, 33.7, 33.6, 33.5];
const strainCurveFractions = [0, 0, 0.04, 0.1, 0.22, 0.38, 0.71, 1];

const dashboardDayKeys = scoreLabels.map((_, index) => `2026-04-${`${10 + index}`.padStart(2, '0')}`);
const dashboardDayDates = dashboardDayKeys.map((dayKey) => {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
});

function buildDashboardWindowSnapshot(options: {
  title: string;
  accent: MetricSeries['accent'];
  unit: string;
  detail: string;
  labels: string[];
  values: number[];
  selectedIndex: number;
  digits?: number;
  hasPartialData?: boolean;
  stepPerDay?: number;
}): MetricSeries {
  const digits = options.digits ?? 0;
  const dayOffset = options.selectedIndex - (dashboardDayKeys.length - 1);
  const shiftedValues = options.values.map((value) => Number((value + dayOffset * (options.stepPerDay ?? 0)).toFixed(digits)));
  const latest = shiftedValues.at(-1) ?? null;
  const avg = average(shiftedValues);
  const delta = shiftedValues.length < 2 ? null : shiftedValues.at(-1)! - shiftedValues[0]!;

  return {
    title: options.title,
    latest: latest === null ? null : Number(latest.toFixed(digits)),
    average: avg === null ? null : Number(avg.toFixed(digits)),
    delta: delta === null ? null : Number(delta.toFixed(digits)),
    unit: options.unit,
    detail: options.detail,
    accent: options.accent,
    hasPartialData: options.hasPartialData,
    series: series(options.labels, shiftedValues),
  };
}

function buildMockCumulativeStrainSeries(score: number | null) {
  return dayMetricLabels.map((label, index) => ({
    label,
    value: score === null ? null : Number((score * strainCurveFractions[index]).toFixed(1)),
  }));
}

function buildDashboardDayState(selectedIndex: number): DashboardDayState {
  const selectedDate = dashboardDayDates[selectedIndex] ?? dashboardDayDates.at(-1)!;
  const availableDays: DashboardDayOption[] = dashboardDayKeys.map((dayKey, index) => ({
    dayKey,
    shortLabel: scoreLabels[index] ?? scoreLabels.at(-1)!,
    longLabel: new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(dashboardDayDates[index] ?? dashboardDayDates.at(-1)!),
  }));
  return {
    dayKey: dashboardDayKeys[selectedIndex] ?? dashboardDayKeys.at(-1)!,
    shortLabel: scoreLabels[selectedIndex] ?? scoreLabels.at(-1)!,
    longLabel: new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(selectedDate),
    isToday: selectedIndex === dashboardDayKeys.length - 1,
    olderDayKey: selectedIndex > 0 ? dashboardDayKeys[selectedIndex - 1] : null,
    olderDayLabel: selectedIndex > 0 ? scoreLabels[selectedIndex - 1] : null,
    newerDayKey: selectedIndex < dashboardDayKeys.length - 1 ? dashboardDayKeys[selectedIndex + 1] : null,
    newerDayLabel: selectedIndex < dashboardDayKeys.length - 1 ? scoreLabels[selectedIndex + 1] : null,
    availableDays,
  };
}

function buildInsights(selectedIndex: number, strain: number | null): DashboardInsight[] {
  const sleepMinutes = sleepDurations[selectedIndex] ?? sleepDurations.at(-1)!;
  const recovery = recoveryTrendValues[selectedIndex] ?? recoveryTrendValues.at(-1)!;
  const stress = stressTrend[selectedIndex] ?? stressTrend.at(-1)!;

  return [
    {
      id: 'recovery',
      title: recovery >= 70 ? 'Recovery is holding up' : 'Recovery is still catching up',
      detail: recovery >= 70 ? 'Sleep and readiness are staying near baseline.' : 'Keep load controlled if you want a stronger rebound tomorrow.',
      accent: recovery >= 70 ? 'green' : 'alert',
    },
    {
      id: 'sleep',
      title: sleepMinutes >= 450 ? 'Sleep duration stayed solid' : 'Sleep duration was below target',
      detail: `${Math.floor(sleepMinutes / 60)}h ${sleepMinutes % 60}m recorded for this night.`,
      accent: sleepMinutes >= 450 ? 'violet' : 'alert',
    },
    {
      id: 'load',
      title: strain !== null && strain >= 10 ? 'Training load was meaningful' : 'Load stayed manageable',
      detail: stress <= 30 ? 'Stress stayed calm through most of the day.' : 'Stress was elevated enough to watch recovery drift.',
      accent: strain !== null && strain >= 10 ? 'cyan' : 'green',
    },
  ];
}

interface MockSleepRecord extends Omit<SleepSession, 'startAt' | 'endAt'> {
  end: Date;
  endDayKey: string;
  start: Date;
}

const sessionSeeds: MockSleepRecord[] = [
  {
    id: 'sleep-1',
    start: new Date(2026, 3, 22, 23, 7, 0, 0),
    end: new Date(2026, 3, 23, 7, 45, 0, 0),
    endDayKey: '2026-04-23',
    dateLabel: 'Apr 23',
    score: 82,
    bedtime: '11:07 PM',
    wakeTime: '7:45 AM',
    completionStatus: 'complete',
    isInProgress: false,
    durationMinutes: 465,
    timeInBedMinutes: 479,
    efficiency: 91,
    remMinutes: 92,
    deepMinutes: 75,
    consistency: 87,
    stages: [
      { stage: 'light', minutes: 32 },
      { stage: 'deep', minutes: 44 },
      { stage: 'light', minutes: 28 },
      { stage: 'rem', minutes: 20 },
      { stage: 'awake', minutes: 8 },
      { stage: 'deep', minutes: 31 },
      { stage: 'light', minutes: 48 },
      { stage: 'rem', minutes: 32 },
      { stage: 'light', minutes: 51 },
      { stage: 'awake', minutes: 6 },
      { stage: 'rem', minutes: 40 },
      { stage: 'light', minutes: 62 },
      { stage: 'deep', minutes: 18 },
      { stage: 'light', minutes: 43 },
    ],
  },
  {
    id: 'sleep-2',
    start: new Date(2026, 3, 21, 22, 54, 0, 0),
    end: new Date(2026, 3, 22, 7, 38, 0, 0),
    endDayKey: '2026-04-22',
    dateLabel: 'Apr 22',
    score: 86,
    bedtime: '10:54 PM',
    wakeTime: '7:38 AM',
    completionStatus: 'complete',
    isInProgress: false,
    durationMinutes: 479,
    timeInBedMinutes: 484,
    efficiency: 93,
    remMinutes: 98,
    deepMinutes: 79,
    consistency: 90,
    stages: [
      { stage: 'light', minutes: 35 },
      { stage: 'deep', minutes: 50 },
      { stage: 'light', minutes: 24 },
      { stage: 'rem', minutes: 24 },
      { stage: 'light', minutes: 55 },
      { stage: 'deep', minutes: 29 },
      { stage: 'rem', minutes: 38 },
      { stage: 'light', minutes: 64 },
      { stage: 'awake', minutes: 5 },
      { stage: 'rem', minutes: 36 },
      { stage: 'light', minutes: 63 },
      { stage: 'deep', minutes: 20 },
      { stage: 'light', minutes: 36 },
    ],
  },
  {
    id: 'sleep-3',
    start: new Date(2026, 3, 20, 23, 21, 0, 0),
    end: new Date(2026, 3, 21, 7, 31, 0, 0),
    endDayKey: '2026-04-21',
    dateLabel: 'Apr 21',
    score: 78,
    bedtime: '11:21 PM',
    wakeTime: '7:31 AM',
    completionStatus: 'complete',
    isInProgress: false,
    durationMinutes: 447,
    timeInBedMinutes: 462,
    efficiency: 89,
    remMinutes: 88,
    deepMinutes: 67,
    consistency: 81,
    stages: [
      { stage: 'light', minutes: 41 },
      { stage: 'deep', minutes: 37 },
      { stage: 'light', minutes: 34 },
      { stage: 'rem', minutes: 22 },
      { stage: 'awake', minutes: 9 },
      { stage: 'light', minutes: 47 },
      { stage: 'deep', minutes: 30 },
      { stage: 'rem', minutes: 26 },
      { stage: 'light', minutes: 70 },
      { stage: 'awake', minutes: 6 },
      { stage: 'rem', minutes: 40 },
      { stage: 'light', minutes: 55 },
      { stage: 'deep', minutes: 18 },
      { stage: 'light', minutes: 12 },
    ],
  },
];

const activitySeeds = [
  {
    id: 'activity-tempo-run',
    title: 'Tempo Run',
    startMinutes: 8 * 60 + 10,
    durationMinutes: 42,
    strain: 12.4,
    calories: 486,
  },
  {
    id: 'activity-mobility-reset',
    title: 'Mobility Reset',
    startMinutes: 12 * 60 + 35,
    durationMinutes: 18,
    strain: 3.1,
    calories: 92,
  },
  {
    id: 'activity-evening-walk',
    title: 'Evening Walk',
    startMinutes: 18 * 60 + 42,
    durationMinutes: 36,
    strain: 5.4,
    calories: 210,
  },
];

const metricSeries = (metric: Omit<MetricSeries, 'series'> & { values: number[]; labels: string[] }): MetricSeries => ({
  title: metric.title,
  latest: metric.latest,
  average: metric.average,
  delta: metric.delta,
  unit: metric.unit,
  detail: metric.detail,
  accent: metric.accent,
  hasPartialData: metric.hasPartialData,
  series: series(metric.labels, metric.values),
});

interface MockActivityRecord {
  id: string;
  title: string;
  startMinutes: number;
  durationMinutes: number;
  strain: number | null;
  calories: number | null;
  source: ActivitySource;
  reviewState: ActivityReviewState;
}

const MANUAL_ACTIVITY_KINDS = new Set<ManualActivityKind>(['Activity', 'Walk', 'Workout', 'Nap']);

function toActivitySummary(activity: MockActivityRecord): ActivitySummary {
  return {
    id: activity.id,
    title: activity.title,
    timeLabel: formatClockMinutes(activity.startMinutes),
    durationMinutes: activity.durationMinutes,
    strain: activity.strain,
    calories: activity.calories,
    source: activity.source,
    reviewState: activity.reviewState,
  };
}

const activitySeedRecords: MockActivityRecord[] = activitySeeds.map((activity) => ({
  id: activity.id,
  title: activity.title,
  startMinutes: activity.startMinutes,
  durationMinutes: activity.durationMinutes,
  strain: activity.strain,
  calories: activity.calories,
  source: 'detected',
  reviewState: 'none',
}));

function dayKeyForDate(date: Date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function formatDateLabel(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function buildMockSleepRecord(start: Date, end: Date): MockSleepRecord {
  const durationMinutes = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
  const sleepScore = Math.round(clamp((durationMinutes / BASE_SLEEP_NEED_MINUTES) * 100, 0, 100));

  return {
    id: `sleep-${dayKeyForDate(end)}`,
    start,
    end,
    endDayKey: dayKeyForDate(end),
    dateLabel: formatDateLabel(end),
    score: sleepScore,
    bedtime: formatClockMinutes(start.getHours() * 60 + start.getMinutes()),
    wakeTime: formatClockMinutes(end.getHours() * 60 + end.getMinutes()),
    completionStatus: 'complete',
    isInProgress: false,
    durationMinutes,
    timeInBedMinutes: durationMinutes,
    efficiency: 100,
    remMinutes: 0,
    deepMinutes: 0,
    consistency: null,
    stages: [],
  };
}

function toSleepSession(session: MockSleepRecord): SleepSession {
  return {
    ...session,
    startAt: session.start.toISOString(),
    endAt: session.end.toISOString(),
  };
}

function parseSleepMarkerId(sleepId: string) {
  const match = /^sleep-(.+)$/.exec(sleepId);
  return match?.[1] ?? null;
}

function buildSleepPlan(
  sleepSessions: readonly MockSleepRecord[],
  alarmSettings: {
    alarmEnabled: boolean;
    alarmOneOffAt: string | null;
    alarmScheduleKind: SleepPlan['alarmScheduleKind'];
    alarmWakeMode: SleepPlan['alarmWakeMode'];
    alarmWeekdayMask: number;
    targetWakeMinutes: number;
  },
): SleepPlan {
  const chronologicalSessions = [...sleepSessions].reverse();
  const sleepDebtMinutes = calculateSleepDebtMinutes(
    chronologicalSessions.map((session) => session.durationMinutes),
  );
  const sleepNeedMinutes = BASE_SLEEP_NEED_MINUTES + sleepDebtMinutes;
  const optimalBedtimeMinutes = calculateOptimalBedtimeMinutes(alarmSettings.targetWakeMinutes, sleepNeedMinutes);

  return {
    targetWakeMinutes: alarmSettings.targetWakeMinutes,
    targetWakeTime: formatClockMinutes(alarmSettings.targetWakeMinutes),
    optimalBedtimeMinutes,
    optimalBedtime: formatClockMinutes(optimalBedtimeMinutes),
    sleepNeedMinutes,
    sleepDebtMinutes,
    napCreditMinutes: 0,
    alarmEnabled: alarmSettings.alarmEnabled,
    alarmScheduleKind: alarmSettings.alarmScheduleKind,
    alarmWeekdayMask: alarmSettings.alarmWeekdayMask,
    alarmWakeMode: alarmSettings.alarmWakeMode,
    alarmOneOffAt: alarmSettings.alarmOneOffAt,
    nextAlarmAt: alarmSettings.alarmEnabled && alarmSettings.alarmWakeMode !== 'score_only'
      ? (alarmSettings.alarmOneOffAt ?? nextAlarmTargetDate(alarmSettings)?.toISOString() ?? null)
      : null,
  };
}

function buildTrendMetric(metric: MetricSeries, id: TrendMetric['id']): TrendMetric {
  return {
    ...metric,
    id,
  };
}

function buildMockSleepMarkerDetails(session: MockSleepRecord): HeartIntradayMarker['details'] {
  return {
    durationMinutes: session.durationMinutes,
    score: session.score,
    completionStatus: session.completionStatus,
    isInProgress: session.isInProgress,
    asleepMinutes: session.durationMinutes,
    timeInBedMinutes: session.timeInBedMinutes,
    remMinutes: session.remMinutes,
    deepMinutes: session.deepMinutes,
    stages: session.stages,
  };
}

function buildMockSleepMarker(
  session: MockSleepRecord,
  windowStart: Date,
  windowEnd: Date,
): HeartIntradayMarker {
  return {
    id: `sleep-${session.endDayKey}`,
    kind: 'sleep',
    label: session.isInProgress ? 'In progress' : 'Sleep',
    timeLabel: session.isInProgress
      ? `${session.bedtime} - synced through ${session.wakeTime}`
      : `${session.bedtime} - ${session.wakeTime}`,
    startFraction: fractionOfWindow(session.start, windowStart, windowEnd),
    endFraction: fractionOfWindow(session.end, windowStart, windowEnd),
    startTimeMs: session.start.getTime(),
    endTimeMs: session.end.getTime(),
    details: buildMockSleepMarkerDetails(session),
  };
}

function buildMockActivityMarkerDetails(activity: MockActivityRecord): HeartIntradayMarker['details'] {
  return {
    durationMinutes: activity.durationMinutes,
    confidence: null,
    source: activity.source,
    reviewState: activity.reviewState,
  };
}

function buildIntradayActivityMarkers(
  activities: MockActivityRecord[],
  windowStart = new Date(2026, 3, 23, 0, 0, 0, 0),
  windowEnd = new Date(2026, 3, 24, 0, 0, 0, 0),
): HeartIntradayMarker[] {
  return activities
    .filter((activity) => activity.reviewState !== 'dismissed')
    .map((activity) => {
      const startTime = new Date(2026, 3, 23, Math.floor(activity.startMinutes / 60), activity.startMinutes % 60, 0, 0);
      const endTime = new Date(
        2026,
        3,
        23,
        Math.floor((activity.startMinutes + activity.durationMinutes) / 60),
        (activity.startMinutes + activity.durationMinutes) % 60,
        0,
        0,
      );

      return {
        id: activity.id,
        kind: activity.title === 'Nap' ? 'nap' as const : 'activity' as const,
        label: activity.title,
        timeLabel: `${formatClockMinutes(activity.startMinutes)} - ${formatClockMinutes(activity.startMinutes + activity.durationMinutes)}`,
        startFraction: fractionOfWindow(startTime, windowStart, windowEnd),
        endFraction: fractionOfWindow(endTime, windowStart, windowEnd),
        startTimeMs: startTime.getTime(),
        endTimeMs: endTime.getTime(),
        details: buildMockActivityMarkerDetails(activity),
      };
    });
}

function activitiesOverlap(left: MockActivityRecord, right: MockActivityRecord) {
  const leftEnd = left.startMinutes + left.durationMinutes;
  const rightEnd = right.startMinutes + right.durationMinutes;
  return left.startMinutes < rightEnd && leftEnd > right.startMinutes;
}

export class MockHealthRepository implements HealthRepository {
  private targetWakeMinutes = 7 * 60 + 45;
  private alarmEnabled = true;
  private alarmScheduleKind: SleepPlan['alarmScheduleKind'] = 'recurring';
  private alarmWeekdayMask = ALARM_WEEKDAY_FULL_MASK;
  private alarmWakeMode: SleepPlan['alarmWakeMode'] = 'exact_time';
  private alarmOneOffAt: string | null = null;
  private manualActivityCount = 0;
  private activities: MockActivityRecord[] = activitySeedRecords.map((activity) => ({ ...activity }));
  private sleepSessions: MockSleepRecord[] = sessionSeeds.map((session) => ({
    ...session,
    start: new Date(session.start.getTime()),
    end: new Date(session.end.getTime()),
    stages: session.stages.map((stage) => ({ ...stage })),
  }));

  constructor(private readonly options: { delayMs?: number } = {}) {}

  private getVisibleActivities() {
    return [...this.activities]
      .filter((activity) => activity.reviewState !== 'dismissed')
      .sort((left, right) => left.startMinutes - right.startMinutes);
  }

  private getActivitySummaries() {
    return this.getVisibleActivities().map((activity) => toActivitySummary(activity));
  }

  private getIntradayMarkers(session = this.sleepSessions[0] ?? this.sleepSessions.at(-1) ?? null) {
    const sleepMarkers = session
      ? [
          buildMockSleepMarker(
            session,
            new Date(`${session.endDayKey}T00:00:00`),
            new Date(new Date(`${session.endDayKey}T00:00:00`).getTime() + 24 * 3600000),
          ),
        ]
      : [];

    return [...sleepMarkers, ...buildIntradayActivityMarkers(this.getVisibleActivities())];
  }

  private getTodayIntradayMarkers() {
    const latestSession = this.sleepSessions[0] ?? this.sleepSessions.at(-1) ?? null;
    const activityMarkers = this.getVisibleActivities().map((activity) => {
      const startHour = Math.floor(activity.startMinutes / 60);
      const startMinute = activity.startMinutes % 60;
      const endMinutes = activity.startMinutes + activity.durationMinutes;
      const endHour = Math.floor(endMinutes / 60);
      const endMinute = endMinutes % 60;

      return {
        id: activity.id,
        kind: activity.title === 'Nap' ? 'nap' as const : 'activity' as const,
        label: activity.title,
        timeLabel: `${formatClockMinutes(activity.startMinutes)} - ${formatClockMinutes(activity.startMinutes + activity.durationMinutes)}`,
        startFraction: fractionOfWindow(
          new Date(2026, 3, 23, startHour, startMinute, 0, 0),
          todayDashboardHeartWindowStart,
          todayDashboardHeartWindowEnd,
        ),
        endFraction: fractionOfWindow(
          new Date(2026, 3, 23, endHour, endMinute, 0, 0),
          todayDashboardHeartWindowStart,
          todayDashboardHeartWindowEnd,
        ),
        startTimeMs: new Date(2026, 3, 23, startHour, startMinute, 0, 0).getTime(),
        endTimeMs: new Date(2026, 3, 23, endHour, endMinute, 0, 0).getTime(),
        details: buildMockActivityMarkerDetails(activity),
      };
    });

    const sleepMarkers = latestSession
      ? [buildMockSleepMarker(latestSession, todayDashboardHeartWindowStart, todayDashboardHeartWindowEnd)]
      : [];

    return [...sleepMarkers, ...activityMarkers];
  }

  private getAlarmSettingsForPlan() {
    return {
      targetWakeMinutes: this.targetWakeMinutes,
      alarmEnabled: this.alarmEnabled,
      alarmScheduleKind: this.alarmScheduleKind,
      alarmWeekdayMask: this.alarmWeekdayMask,
      alarmWakeMode: this.alarmWakeMode,
      alarmOneOffAt: this.alarmOneOffAt,
    };
  }

  private getActivityById(activityId: string) {
    const activity = this.activities.find((entry) => entry.id === activityId);

    if (!activity) {
      throw new Error(`Activity not found: ${activityId}`);
    }

    return activity;
  }

  private getSleepById(sleepId: string) {
    const sleepDayKey = parseSleepMarkerId(sleepId);
    if (!sleepDayKey) {
      throw new Error(`Unknown sleep id: ${sleepId}`);
    }

    const session = this.sleepSessions.find((entry) => entry.endDayKey === sleepDayKey);
    if (!session) {
      throw new Error(`Sleep not found: ${sleepId}`);
    }

    return session;
  }

  async getDerivedRefreshState(): Promise<DerivedRefreshState> {
    return {
      status: 'idle',
      pendingFromTime: null,
      pendingToTime: null,
      lastProcessedFromTime: '2026-04-23 07:45:00',
      lastProcessedToTime: '2026-04-23 07:45:00',
      lastError: null,
      isFirstSync: false,
    };
  }

  async processPendingDerivedRefresh(): Promise<boolean> {
    return false;
  }

  async rescanActivities(): Promise<ActivityRescanResult> {
    await this.wait();

    const removedUnconfirmedActivities = this.activities.filter(
      (activity) => activity.source === 'detected' && activity.reviewState === 'none',
    ).length;
    const preservedActivities = this.activities.filter(
      (activity) => !(activity.source === 'detected' && activity.reviewState === 'none'),
    );
    const reviewedActivities = preservedActivities.filter((activity) => activity.reviewState !== 'none');
    const rescannedActivities = activitySeedRecords
      .map((activity) => ({ ...activity }))
      .filter((activity) => !reviewedActivities.some((reviewed) => activitiesOverlap(activity, reviewed)));

    this.activities = [...preservedActivities, ...rescannedActivities];

    return {
      removedUnconfirmedActivities,
    };
  }

  async createManualActivity(activity: ManualActivityKind, start: Date, end: Date): Promise<string> {
    await this.wait();

    if (!MANUAL_ACTIVITY_KINDS.has(activity)) {
      throw new Error(`Unsupported manual activity kind: ${activity}`);
    }

    if (end.getTime() <= start.getTime()) {
      throw new Error('Manual activity end must be after start.');
    }

    this.manualActivityCount += 1;

    const manualActivity: MockActivityRecord = {
      id: `manual-${this.manualActivityCount}`,
      title: activity,
      startMinutes: start.getHours() * 60 + start.getMinutes(),
      durationMinutes: Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000)),
      strain: null,
      calories: null,
      source: 'manual',
      reviewState: 'confirmed',
    };

    this.activities = [...this.activities, manualActivity];
    return manualActivity.id;
  }

  async createManualSleep(start: Date, end: Date): Promise<string> {
    await this.wait();

    if (end.getTime() <= start.getTime()) {
      throw new Error('Manual sleep end must be after start.');
    }

    const sleepDayKey = dayKeyForDate(end);
    if (this.sleepSessions.some((session) => session.endDayKey === sleepDayKey)) {
      throw new Error('A sleep already exists for this day. Focus it and edit instead.');
    }

    this.sleepSessions = [...this.sleepSessions, buildMockSleepRecord(start, end)].sort(
      (left, right) => right.end.getTime() - left.end.getTime(),
    );

    return `sleep-${sleepDayKey}`;
  }

  async updateActivity(activityId: string, activity: ManualActivityKind, start: Date, end: Date): Promise<void> {
    await this.wait();

    if (!MANUAL_ACTIVITY_KINDS.has(activity)) {
      throw new Error(`Unsupported manual activity kind: ${activity}`);
    }

    if (end.getTime() <= start.getTime()) {
      throw new Error('Manual activity end must be after start.');
    }

    const entry = this.getActivityById(activityId);
    entry.title = activity;
    entry.startMinutes = start.getHours() * 60 + start.getMinutes();
    entry.durationMinutes = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
    entry.source = 'manual';
    entry.reviewState = 'confirmed';
  }

  async updateSleep(sleepId: string, start: Date, end: Date): Promise<void> {
    await this.wait();

    if (end.getTime() <= start.getTime()) {
      throw new Error('Sleep end must be after start.');
    }

    const current = this.getSleepById(sleepId);
    const nextSleepDayKey = dayKeyForDate(end);
    if (nextSleepDayKey !== current.endDayKey && this.sleepSessions.some((session) => session.endDayKey === nextSleepDayKey)) {
      throw new Error('A sleep already exists for this day. Focus it and edit instead.');
    }

    const nextSession = buildMockSleepRecord(start, end);
    this.sleepSessions = this.sleepSessions
      .map((session) => (session.endDayKey === current.endDayKey ? nextSession : session))
      .sort((left, right) => right.end.getTime() - left.end.getTime());
  }

  async confirmActivity(activityId: string): Promise<void> {
    await this.wait();
    this.getActivityById(activityId).reviewState = 'confirmed';
  }

  async dismissActivity(activityId: string): Promise<void> {
    await this.wait();
    this.getActivityById(activityId).reviewState = 'dismissed';
  }

  async relabelActivity(activityId: string, activity: ManualActivityKind): Promise<void> {
    await this.wait();

    if (!MANUAL_ACTIVITY_KINDS.has(activity)) {
      throw new Error(`Unsupported manual activity kind: ${activity}`);
    }

    const entry = this.getActivityById(activityId);
    entry.title = activity;
    entry.reviewState = entry.source === 'manual' ? 'confirmed' : 'relabelled';
  }

  private async wait() {
    await delay(this.options.delayMs ?? 180);
  }

  private async buildOverviewSeed(dayKey?: string) {
    await this.wait();

    const resolvedIndex = dayKey ? dashboardDayKeys.indexOf(dayKey) : dashboardDayKeys.length - 1;
    const selectedIndex = resolvedIndex >= 0 ? resolvedIndex : dashboardDayKeys.length - 1;
    const useRollingTodayHeartWindow = dayKey === undefined;
    const day = buildDashboardDayState(selectedIndex);
    const hrvCard = buildDashboardWindowSnapshot({
      title: 'HRV',
      accent: 'green',
      unit: 'ms',
      detail: 'Overnight HRV across the selected sleep window.',
      labels: overnightMetricLabels,
      values: hrvOvernightSeries,
      selectedIndex,
      stepPerDay: -0.3,
    });
    const stressCard = buildDashboardWindowSnapshot({
      title: 'Stress',
      accent: 'alert',
      unit: '',
      detail: 'Stress drift across the selected day.',
      labels: dayMetricLabels,
      values: stressDaySeries,
      selectedIndex,
      stepPerDay: -0.2,
    });
    const spo2Card = buildDashboardWindowSnapshot({
      title: 'SpO2',
      accent: 'cyan',
      unit: '%',
      detail: 'Overnight oxygen through the selected sleep window.',
      labels: overnightMetricLabels,
      values: spo2OvernightSeries,
      selectedIndex,
    });
    const skinTemperatureCard = buildDashboardWindowSnapshot({
      title: 'Skin Temperature',
      accent: 'heart',
      unit: '°C',
      detail: 'Overnight skin temperature through the selected sleep window.',
      labels: overnightMetricLabels,
      values: skinTemperatureOvernightSeries,
      selectedIndex,
      digits: 1,
      hasPartialData: true,
      stepPerDay: 0.02,
    });
    const selectedSession = this.sleepSessions.find((session) => session.endDayKey === day.dayKey) ?? this.sleepSessions[0];
    const strainScore = strainValues[selectedIndex] ?? strainValues.at(-1) ?? null;
    const dayOffset = Math.max(0, dashboardDayKeys.length - 1 - selectedIndex);
    const selectedActivities = this.getActivitySummaries().slice(
      0,
      selectedIndex >= dashboardDayKeys.length - 2 ? 3 : selectedIndex >= dashboardDayKeys.length - 4 ? 2 : 1,
    );
    const tonightPlan = buildSleepPlan(this.sleepSessions, this.getAlarmSettingsForPlan());

    return {
      layoutVersion: 2,
      greeting: day.isToday ? 'Good afternoon' : 'Overview',
      dateLabel: day.longLabel,
      day,
      recovery: {
        score: recoveryTrendValues[selectedIndex] ?? recoveryTrendValues.at(-1)!,
        label: describeRecovery(recoveryTrendValues[selectedIndex] ?? recoveryTrendValues.at(-1)!),
        caption: 'Recovery',
      },
      tonightPlan,
      summaryStats: [
        { label: 'HRV', value: `${hrvTrend[selectedIndex] ?? hrvTrend.at(-1)} ms`, accent: 'green' },
        { label: 'RHR', value: `${restingHrTrend[selectedIndex] ?? restingHrTrend.at(-1)} bpm`, accent: 'cyan' },
        { label: 'Sleep', value: `${Math.floor((sleepDurations[selectedIndex] ?? sleepDurations.at(-1)!) / 60)}h ${(sleepDurations[selectedIndex] ?? sleepDurations.at(-1)!) % 60}m`, accent: 'violet' },
        { label: 'Strain', value: `${(strainScore ?? 0).toFixed(1)}`, accent: 'heart' },
      ],
      heartCard: {
        restingHr: restingHrTrend[selectedIndex] ?? 48,
        averageHr: useRollingTodayHeartWindow ? todayDashboardAverageHr : intradayAverageHr - dayOffset,
        maxHr: useRollingTodayHeartWindow ? todayDashboardMaxHr : intradayMaxHr - dayOffset * 2,
        pointIntervalMinutes: 5,
        series: useRollingTodayHeartWindow ? todayDashboardHeartSeries : dashboardHeartSeries,
        markers: useRollingTodayHeartWindow ? this.getTodayIntradayMarkers() : this.getIntradayMarkers(selectedSession),
      },
      sleepCard: {
        score: selectedSession.score,
        durationMinutes: selectedSession.durationMinutes,
        timeInBedMinutes: selectedSession.timeInBedMinutes,
        stages: selectedSession.stages,
        startLabel: selectedSession.bedtime,
        middleLabel: '3:26 AM',
        endLabel: selectedSession.wakeTime,
        completionStatus: selectedSession.completionStatus,
        isInProgress: selectedSession.isInProgress,
      },
      strainCard: {
        score: strainScore,
        label: strainScore === null ? 'Waiting for effort' : strainScore >= 14 ? 'Loaded' : strainScore >= 8 ? 'Building' : 'Light',
        series: buildMockCumulativeStrainSeries(strainScore),
      },
      hrvCard,
      stressCard,
      spo2Card,
      skinTemperatureCard,
      activitySummary: selectedActivities,
      insights: buildInsights(selectedIndex, strainScore),
      lastSyncLabel: day.isToday ? 'Last sync 7:45 AM' : `Showing ${day.shortLabel}`,
    };
  }

  async getHistoryOverview(dayKey: string): Promise<HistoryOverview> {
    const overview = await this.buildOverviewSeed(dayKey);

    return {
      dateLabel: overview.dateLabel,
      day: overview.day,
      recovery: overview.recovery,
      heartCard: overview.heartCard,
      sleepCard: overview.sleepCard,
      strainCard: overview.strainCard,
      activitySummary: overview.activitySummary,
      insights: overview.insights,
    };
  }

  async getTodayOverview(): Promise<TodayOverview> {
    const overview = await this.buildOverviewSeed();

    return {
      greeting: overview.greeting,
      dateLabel: overview.dateLabel,
      day: overview.day,
      recovery: overview.recovery,
      tonightPlan: overview.tonightPlan,
      sleepCard: overview.sleepCard,
      strainCard: overview.strainCard,
      activitySummary: overview.activitySummary,
      insights: overview.insights,
    };
  }

  async getSleepHistory(range: HistoryRange): Promise<SleepHistoryData> {
    await this.wait();

    const latestSleep = this.sleepSessions[0] ?? null;

    return {
      headlineScore: latestSleep?.score ?? 82,
      headlineLabel: 'Good sleep',
      bedtime: latestSleep?.bedtime ?? '11:07 PM',
      wakeTime: latestSleep?.wakeTime ?? '7:45 AM',
      completionStatus: latestSleep?.completionStatus ?? 'complete',
      isInProgress: latestSleep?.isInProgress ?? false,
      durationMinutes: latestSleep?.durationMinutes ?? 465,
      timeInBedMinutes: latestSleep?.timeInBedMinutes ?? 479,
      bedtimeConsistency: 88,
      wakeConsistency: 91,
      scoreTrend: takeTail(series(scoreLabels, sleepScores), range),
      durationTrend: takeTail(series(scoreLabels, sleepDurations), range),
      sessions: this.sleepSessions.slice(0, 3).map(toSleepSession),
      sleepPlan: buildSleepPlan(this.sleepSessions, this.getAlarmSettingsForPlan()),
    };
  }

  async getHeartHistory(range: HistoryRange): Promise<HeartHistoryData> {
    await this.wait();

    return {
      restingHr: 48,
      averageHr: intradayAverageHr,
      maxHr: intradayMaxHr,
      intraday: intradayHeartSeries,
      intradayMarkers: this.getIntradayMarkers(),
      weeklyResting: takeTail(series(scoreLabels, restingHrTrend), range),
      recoveryShift: -4,
    };
  }

  async getDashboardHeartTimeline(range: HistoryRange): Promise<HeartCardData> {
    const window = await this.getDashboardHeartTimelineWindow(range);

    return buildHeartCardDataFromWindow(window);
  }

  async getDashboardHeartTimelineWindow(range: HistoryRange): Promise<HeartTimelineWindow> {
    await this.wait();

    const endDate = todayDashboardHeartWindowEnd;
    const startDate = new Date(endDate.getTime() - rangeHours(range) * 3600000);
    const samples = buildHeartTimelineSamples(1, startDate, rangeHours(range) * 60 + 1);
    const values = samples.map((sample) => sample.bpm).filter((value): value is number => value !== null);
    const latestSession = this.sleepSessions[0] ?? this.sleepSessions.at(-1) ?? null;
    const markers = [
      ...(latestSession ? [buildMockSleepMarker(latestSession, startDate, endDate)] : []),
      ...buildIntradayActivityMarkers(this.getVisibleActivities(), startDate, endDate),
    ];

    return {
      restingHr: 48,
      averageHr: Math.round(mean(values)),
      maxHr: sustainedPeakBpm(values),
      latestHeartDate: endDate,
      intradayStart: startDate,
      samples,
      markers,
      missingReason: samples.length === 0 ? 'No local history yet. Sync the wearable from Settings to unlock this view.' : null,
    };
  }

  async getFocusedHeartDetail(marker: HeartIntradayMarker): Promise<FocusedHeartDetail> {
    await this.wait();

    const startTimeMs = marker.startTimeMs ?? null;
    const endTimeMs = marker.endTimeMs ?? null;

    if (startTimeMs === null || endTimeMs === null || endTimeMs <= startTimeMs) {
      return {
        averageHr: null,
        maxHr: null,
        pointIntervalMinutes: 5,
        series: [],
        marker: {
          ...marker,
          startFraction: 0,
          endFraction: 1,
        },
        missingReason: 'Focused heart detail is unavailable for this marker.',
      };
    }

    const startDate = new Date(startTimeMs);
    const endDate = new Date(endTimeMs);
    const durationMinutes = Math.max((endTimeMs - startTimeMs) / 60000, 1 / 60);
    const pointIntervalMinutes = 5;
    const pointCount = Math.max(2, Math.floor(durationMinutes / pointIntervalMinutes) + 1);
    const series = buildIntradayHeartSeries(pointIntervalMinutes, startDate, pointCount);
    const values = series.map((point) => point.value).filter((value): value is number => value !== null);

    return {
      averageHr: values.length > 0 ? Math.round(mean(values)) : null,
      maxHr: values.length > 0 ? sustainedPeakBpm(values) ?? Math.max(...values) : null,
      pointIntervalMinutes,
      series,
      marker: {
        ...marker,
        startFraction: 0,
        endFraction: 1,
      },
      missingReason: series.length === 0 ? 'Focused heart detail is unavailable for this marker.' : null,
    };
  }

  async getWellnessData(range: HistoryRange): Promise<WellnessData> {
    await this.wait();

    return {
      stress: {
        ...metricSeries({
          title: 'Stress',
          latest: 29,
          average: 35,
          delta: -6,
          unit: '',
          detail: 'Calmer than your recent baseline',
          accent: 'green',
          values: [42, 39, 37, 34, 33, 32, 31, 31, 30, 29, 30, 29, 28, 29],
          labels: scoreLabels,
        }),
        series: takeTail(
          metricSeries({
            title: 'Stress',
            latest: 29,
            average: 35,
            delta: -6,
            unit: '',
            detail: 'Calmer than your recent baseline',
            accent: 'green',
            values: [42, 39, 37, 34, 33, 32, 31, 31, 30, 29, 30, 29, 28, 29],
            labels: scoreLabels,
          }).series,
          range
        ),
      },
      spo2: {
        ...metricSeries({
          title: 'SpO2',
          latest: 97,
          average: 96.4,
          delta: 0.8,
          unit: '%',
          detail: 'Overnight oxygen remained steady',
          accent: 'cyan',
          values: [95, 96, 96, 97, 96, 97, 97, 96, 96, 97, 97, 96, 97, 97],
          labels: scoreLabels,
        }),
        series: takeTail(
          metricSeries({
            title: 'SpO2',
            latest: 97,
            average: 96.4,
            delta: 0.8,
            unit: '%',
            detail: 'Overnight oxygen remained steady',
            accent: 'cyan',
            values: [95, 96, 96, 97, 96, 97, 97, 96, 96, 97, 97, 96, 97, 97],
            labels: scoreLabels,
          }).series,
          range
        ),
      },
      skinTemperature: {
        ...metricSeries({
          title: 'Skin Temperature',
          latest: 33.8,
          average: 33.5,
          delta: 0.3,
          unit: '°C',
          detail: 'Limited samples while the sensor warmed up',
          accent: 'alert',
          hasPartialData: true,
          values: [33.2, 33.1, 33.3, 33.4, 33.5, 33.6, 33.6, 33.4, 33.5, 33.6, 33.7, 33.7, 33.8, 33.8],
          labels: scoreLabels,
        }),
        series: takeTail(
          metricSeries({
            title: 'Skin Temperature',
            latest: 33.8,
            average: 33.5,
            delta: 0.3,
            unit: '°C',
            detail: 'Limited samples while the sensor warmed up',
            accent: 'alert',
            hasPartialData: true,
            values: [33.2, 33.1, 33.3, 33.4, 33.5, 33.6, 33.6, 33.4, 33.5, 33.6, 33.7, 33.7, 33.8, 33.8],
            labels: scoreLabels,
          }).series,
          range
        ),
      },
      recoveryIndex: {
        ...metricSeries({
          title: 'Recovery Index',
          latest: 64,
          average: 71,
          delta: -7,
          unit: '%',
          detail: 'Still settling after yesterday\'s run load',
          accent: 'violet',
          values: [75, 77, 73, 71, 74, 72, 69, 70, 72, 68, 66, 65, 64, 64],
          labels: scoreLabels,
        }),
        series: takeTail(
          metricSeries({
            title: 'Recovery Index',
            latest: 64,
            average: 71,
            delta: -7,
            unit: '%',
            detail: 'Still settling after yesterday\'s run load',
            accent: 'violet',
            values: [75, 77, 73, 71, 74, 72, 69, 70, 72, 68, 66, 65, 64, 64],
            labels: scoreLabels,
          }).series,
          range
        ),
      },
      activities: this.getActivitySummaries(),
    };
  }

  async getTrendData(range: HistoryRange): Promise<TrendData> {
    await this.wait();

    const recoveryMetric = {
      ...metricSeries({
        title: 'Recovery',
        latest: recoveryTrendValues.at(-1) ?? null,
        average: average(recoveryTrendValues),
        delta:
          recoveryTrendValues.length < 2
            ? null
            : (recoveryTrendValues.at(-1) ?? 0) - (recoveryTrendValues.at(-2) ?? 0),
        unit: '%',
        detail: 'Transparent readiness heuristic across the selected range.',
        accent: 'green',
        values: recoveryTrendValues,
        labels: scoreLabels,
      }),
      series: takeTail(series(scoreLabels, recoveryTrendValues), range),
    } satisfies MetricSeries;
    const hrvMetric = {
      ...metricSeries({
        title: 'HRV',
        latest: hrvTrend.at(-1) ?? null,
        average: average(hrvTrend),
        delta:
          hrvTrend.length < 2
            ? null
            : (hrvTrend.at(-1) ?? 0) - (hrvTrend.at(-2) ?? 0),
        unit: 'ms',
        detail: 'Overnight HRV across the selected range.',
        accent: 'green',
        values: hrvTrend,
        labels: scoreLabels,
      }),
      series: takeTail(series(scoreLabels, hrvTrend), range),
    } satisfies MetricSeries;
    const sleepScoreMetric = {
      ...metricSeries({
        title: 'Sleep Score',
        latest: sleepScores.at(-1) ?? null,
        average: average(sleepScores),
        delta:
          sleepScores.length < 2
            ? null
            : (sleepScores.at(-1) ?? 0) - (sleepScores.at(-2) ?? 0),
        unit: '%',
        detail: 'Nightly sleep score across the selected range.',
        accent: 'violet',
        values: sleepScores,
        labels: scoreLabels,
      }),
      series: takeTail(series(scoreLabels, sleepScores), range),
    } satisfies MetricSeries;
    const restingMetric = {
      ...metricSeries({
        title: 'Resting HR',
        latest: restingHrTrend.at(-1) ?? null,
        average: average(restingHrTrend),
        delta:
          restingHrTrend.length < 2
            ? null
            : (restingHrTrend.at(-1) ?? 0) - (restingHrTrend.at(-2) ?? 0),
        unit: 'bpm',
        detail: 'Nightly resting heart rate across the selected range.',
        accent: 'cyan',
        values: restingHrTrend,
        labels: scoreLabels,
      }),
      series: takeTail(series(scoreLabels, restingHrTrend), range),
    } satisfies MetricSeries;
    const sleepDurationMetric = {
      ...metricSeries({
        title: 'Sleep Duration',
        latest: sleepDurationHours.at(-1) ?? null,
        average: average(sleepDurationHours),
        delta:
          sleepDurationHours.length < 2
            ? null
            : (sleepDurationHours.at(-1) ?? 0) - (sleepDurationHours.at(-2) ?? 0),
        unit: 'h',
        detail: 'Nightly time asleep across the selected range.',
        accent: 'cyan',
        values: sleepDurationHours,
        labels: scoreLabels,
      }),
      series: takeTail(series(scoreLabels, sleepDurationHours), range),
    } satisfies MetricSeries;
    const sleepConsistencyMetric = {
      ...metricSeries({
        title: 'Sleep Consistency',
        latest: sleepConsistencyTrend.at(-1) ?? null,
        average: average(sleepConsistencyTrend),
        delta:
          sleepConsistencyTrend.length < 2
            ? null
            : (sleepConsistencyTrend.at(-1) ?? 0) - (sleepConsistencyTrend.at(-2) ?? 0),
        unit: '%',
        detail: 'Rolling bedtime and wake-time stability across recent nights.',
        accent: 'violet',
        values: sleepConsistencyTrend,
        labels: scoreLabels,
      }),
      series: takeTail(series(scoreLabels, sleepConsistencyTrend), range),
    } satisfies MetricSeries;
    const stressMetric = {
      ...metricSeries({
        title: 'Stress',
        latest: stressTrend.at(-1) ?? null,
        average: average(stressTrend),
        delta:
          stressTrend.length < 2
            ? null
            : (stressTrend.at(-1) ?? 0) - (stressTrend.at(-2) ?? 0),
        unit: '',
        detail: 'Daily stress drift across the selected range.',
        accent: 'alert',
        values: stressTrend,
        labels: scoreLabels,
      }),
    } satisfies MetricSeries;
    const skinTemperatureDeviationMetric = {
      ...metricSeries({
        title: 'Skin Temp Deviation',
        latest: skinTemperatureDeviationTrend.at(-1) ?? null,
        average: average(skinTemperatureDeviationTrend),
        delta:
          skinTemperatureDeviationTrend.length < 2
            ? null
            : (skinTemperatureDeviationTrend.at(-1) ?? 0) - (skinTemperatureDeviationTrend.at(-2) ?? 0),
        unit: '°C',
        detail: 'Overnight temperature stayed above your recent baseline.',
        accent: 'heart',
        values: skinTemperatureDeviationTrend,
        labels: scoreLabels,
      }),
      series: takeTail(series(scoreLabels, skinTemperatureDeviationTrend), range),
    } satisfies MetricSeries;

    return {
      range,
      latestLabel: buildDashboardDayState(dashboardDayKeys.length - 1).longLabel,
      primaryMetrics: [
        buildTrendMetric(recoveryMetric, 'recovery'),
        buildTrendMetric(hrvMetric, 'hrv'),
        buildTrendMetric(restingMetric, 'restingHr'),
        buildTrendMetric(sleepScoreMetric, 'sleepScore'),
      ],
      secondaryMetrics: [
        buildTrendMetric(sleepDurationMetric, 'sleepDuration'),
        buildTrendMetric(sleepConsistencyMetric, 'sleepConsistency'),
        buildTrendMetric(stressMetric, 'stress'),
        buildTrendMetric(skinTemperatureDeviationMetric, 'skinTemperatureDeviation'),
      ],
    };
  }

  async setTargetWakeMinutes(minutes: number): Promise<void> {
    await this.wait();
    this.targetWakeMinutes = roundClockMinutes(minutes);
    this.alarmEnabled = false;
    this.alarmOneOffAt = null;
  }

  async enableAlarm(settings: AlarmSettingsInput): Promise<void> {
    await this.wait();
    const alarmScheduleKind = normalizeAlarmScheduleKind(settings.alarmScheduleKind);
    const alarmWeekdayMask = Math.trunc(settings.alarmWeekdayMask) & ALARM_WEEKDAY_FULL_MASK;

    if (alarmScheduleKind === 'recurring' && alarmWeekdayMask === 0) {
      throw new Error('Select at least one wake day before enabling a recurring alarm.');
    }

    this.targetWakeMinutes = roundClockMinutes(settings.targetWakeMinutes);
    this.alarmScheduleKind = alarmScheduleKind;
    this.alarmWeekdayMask = normalizeAlarmWeekdayMask(alarmWeekdayMask);
    this.alarmWakeMode = normalizeAlarmWakeMode(settings.alarmWakeMode);
    this.alarmOneOffAt =
      alarmScheduleKind === 'one_off'
        ? nextAlarmTargetDate({
            ...settings,
            alarmScheduleKind,
            alarmWeekdayMask: this.alarmWeekdayMask,
            targetWakeMinutes: this.targetWakeMinutes,
          })?.toISOString() ?? null
        : null;
    this.alarmEnabled = true;
  }

  async disableAlarm(targetWakeMinutes: number): Promise<void> {
    await this.wait();
    this.targetWakeMinutes = roundClockMinutes(targetWakeMinutes);
    this.alarmEnabled = false;
    this.alarmOneOffAt = null;
  }
}
