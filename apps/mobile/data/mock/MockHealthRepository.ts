import type { HealthRepository } from '@/data/HealthRepository';
import type {
  DerivedRefreshState,
  ActivitySummary,
  DashboardDayState,
  DashboardInsight,
  DashboardSnapshot,
  HeartIntradayMarker,
  HeartHistorySnapshot,
  HistoryRange,
  MetricSeries,
  SleepHistorySnapshot,
  SleepSession,
  TrendPoint,
  WellnessSnapshot,
} from '@/types/health';
import { formatAxisTime, formatClockMinutes } from '@/utils/dateTime';
import { describeRecovery } from '@/utils/formatters';
import { sustainedPeakBpm } from '@/utils/heartRate';
import { BASE_SLEEP_NEED_MINUTES, calculateOptimalBedtimeMinutes, calculateSleepDebtMinutes, roundClockMinutes } from '@/utils/sleepPlan';

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

function buildIntradayHeartSeries(stepMinutes: number): TrendPoint[] {
  const baseDate = new Date(2026, 3, 23, 0, 0, 0, 0);
  const pointCount = (24 * 60) / stepMinutes;

  return Array.from({ length: pointCount }, (_, index) => {
    const minuteOfDay = index * stepMinutes;
    const time = new Date(baseDate.getTime() + minuteOfDay * 60000);
    const circadianBaseline = 68 + Math.sin((minuteOfDay / (24 * 60)) * Math.PI * 2 - Math.PI / 2) * 7;
    const morningRise = gaussian(minuteOfDay, 420, 70, 18);
    const middayPush = gaussian(minuteOfDay, 780, 45, 96);
    const eveningWalk = gaussian(minuteOfDay, 1110, 70, 20);
    const overnightDip = gaussian(minuteOfDay, 180, 80, 11);
    const value = Math.round(clamp(circadianBaseline + morningRise + middayPush + eveningWalk - overnightDip, 52, 172));

    return {
      label: formatAxisTime(time),
      value,
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

function takeTail<T>(items: T[], range: HistoryRange): T[] {
  return items.slice(-rangeLength(range));
}

function fractionOfDay(minutes: number) {
  return clamp(minutes / (24 * 60), 0, 1);
}

const intradayHeartSeries = buildIntradayHeartSeries(5);
const dashboardHeartSeries = intradayHeartSeries;
const intradayValues = intradayHeartSeries
  .map((point) => point.value)
  .filter((value): value is number => value !== null);
const intradayAverageHr = Math.round(mean(intradayValues));
const intradayMaxHr = sustainedPeakBpm(intradayValues) ?? Math.max(...intradayValues);
const strainValues = [4.4, 4.8, 5.2, 6.1, 6.8, 7.2, 7.6, 8.1, 9.4, 10.8, 9.9, 10.1, 10.9, 11];
const scoreLabels = ['Apr 10', 'Apr 11', 'Apr 12', 'Apr 13', 'Apr 14', 'Apr 15', 'Apr 16', 'Apr 17', 'Apr 18', 'Apr 19', 'Apr 20', 'Apr 21', 'Apr 22', 'Apr 23'];
const sleepScores = [71, 76, 74, 79, 82, 77, 81, 84, 80, 83, 78, 82, 86, 82];
const sleepDurations = [404, 421, 438, 455, 463, 444, 458, 470, 452, 476, 447, 465, 479, 465];
const restingHrTrend = [53, 52, 51, 50, 50, 49, 49, 48, 48, 47, 48, 49, 48, 48];
const hrvTrend = [71, 74, 69, 72, 77, 75, 78, 81, 76, 79, 74, 78, 84, 82];
const stressTrend = [42, 39, 37, 34, 33, 32, 31, 31, 30, 29, 30, 29, 28, 29];
const spo2Trend = [95, 96, 96, 97, 96, 97, 97, 96, 96, 97, 97, 96, 97, 97];
const skinTemperatureTrend = [33.2, 33.1, 33.3, 33.4, 33.5, 33.6, 33.6, 33.4, 33.5, 33.6, 33.7, 33.7, 33.8, 33.8];
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

const sessions: SleepSession[] = [
  {
    id: 'sleep-1',
    dateLabel: 'Apr 23',
    score: 82,
    bedtime: '11:07 PM',
    wakeTime: '7:45 AM',
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
    dateLabel: 'Apr 22',
    score: 86,
    bedtime: '10:54 PM',
    wakeTime: '7:38 AM',
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
    dateLabel: 'Apr 21',
    score: 78,
    bedtime: '11:21 PM',
    wakeTime: '7:31 AM',
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

const activities: ActivitySummary[] = activitySeeds.map((activity) => ({
  id: activity.id,
  title: activity.title,
  timeLabel: formatClockMinutes(activity.startMinutes),
  durationMinutes: activity.durationMinutes,
  strain: activity.strain,
  calories: activity.calories,
}));

const intradayMarkers: HeartIntradayMarker[] = [
  {
    id: 'sleep-latest',
    kind: 'sleep',
    label: 'Sleep',
    timeLabel: '12:00 AM - 7:45 AM',
    startFraction: 0,
    endFraction: fractionOfDay(7 * 60 + 45),
  },
  ...activitySeeds.map((activity) => ({
    id: activity.id,
    kind: 'activity' as const,
    label: activity.title,
    timeLabel: `${formatClockMinutes(activity.startMinutes)} - ${formatClockMinutes(activity.startMinutes + activity.durationMinutes)}`,
    startFraction: fractionOfDay(activity.startMinutes),
    endFraction: fractionOfDay(activity.startMinutes + activity.durationMinutes),
  })),
];

export class MockHealthRepository implements HealthRepository {
  private targetWakeMinutes = 7 * 60 + 45;
  private alarmEnabled = true;

  constructor(private readonly options: { delayMs?: number } = {}) {}

  async primeDashboardSnapshot(): Promise<boolean> {
    return false;
  }

  async refreshDashboardSnapshot(): Promise<boolean> {
    return true;
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

  invalidateCaches(): void {}

  private async wait() {
    await delay(this.options.delayMs ?? 180);
  }

  async getDashboardSnapshot(dayKey?: string): Promise<DashboardSnapshot> {
    await this.wait();

    const resolvedIndex = dayKey ? Math.max(0, dashboardDayKeys.indexOf(dayKey)) : dashboardDayKeys.length - 1;
    const selectedIndex = resolvedIndex === -1 ? dashboardDayKeys.length - 1 : resolvedIndex;
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
    const selectedSession = sessions[Math.max(0, sessions.length - 1 - (dashboardDayKeys.length - 1 - selectedIndex))] ?? sessions[0];
    const strainScore = strainValues[selectedIndex] ?? strainValues.at(-1) ?? null;
    const selectedActivities = activities.slice(0, selectedIndex >= dashboardDayKeys.length - 2 ? 3 : selectedIndex >= dashboardDayKeys.length - 4 ? 2 : 1);

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
      summaryStats: [
        { label: 'HRV', value: `${hrvTrend[selectedIndex] ?? hrvTrend.at(-1)} ms`, accent: 'green' },
        { label: 'RHR', value: `${restingHrTrend[selectedIndex] ?? restingHrTrend.at(-1)} bpm`, accent: 'cyan' },
        { label: 'Sleep', value: `${Math.floor((sleepDurations[selectedIndex] ?? sleepDurations.at(-1)!) / 60)}h ${(sleepDurations[selectedIndex] ?? sleepDurations.at(-1)!) % 60}m`, accent: 'violet' },
        { label: 'Strain', value: `${(strainScore ?? 0).toFixed(1)}`, accent: 'heart' },
      ],
      heartCard: {
        restingHr: restingHrTrend[selectedIndex] ?? 48,
        averageHr: intradayAverageHr - Math.max(0, dashboardDayKeys.length - 1 - selectedIndex),
        maxHr: intradayMaxHr - Math.max(0, dashboardDayKeys.length - 1 - selectedIndex) * 2,
        series: dashboardHeartSeries,
        markers: intradayMarkers,
      },
      sleepCard: {
        score: selectedSession.score,
        durationMinutes: selectedSession.durationMinutes,
        timeInBedMinutes: selectedSession.timeInBedMinutes,
        stages: selectedSession.stages,
        startLabel: selectedSession.bedtime,
        middleLabel: '3:26 AM',
        endLabel: selectedSession.wakeTime,
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

  async getSleepHistory(range: HistoryRange): Promise<SleepHistorySnapshot> {
    await this.wait();

    const chronologicalSessions = [...sessions].reverse();
    const sleepDebtMinutes = calculateSleepDebtMinutes(
      chronologicalSessions.map((session) => session.durationMinutes),
    );
    const sleepNeedMinutes = BASE_SLEEP_NEED_MINUTES + sleepDebtMinutes;
    const optimalBedtimeMinutes = calculateOptimalBedtimeMinutes(this.targetWakeMinutes, sleepNeedMinutes);

    return {
      headlineScore: 82,
      headlineLabel: 'Good sleep',
      bedtime: '11:07 PM',
      wakeTime: '7:45 AM',
      durationMinutes: 465,
      timeInBedMinutes: 479,
      bedtimeConsistency: 88,
      wakeConsistency: 91,
      scoreTrend: takeTail(series(scoreLabels, sleepScores), range),
      durationTrend: takeTail(series(scoreLabels, sleepDurations), range),
      sessions: sessions.slice(0, 3),
      sleepPlan: {
        targetWakeMinutes: this.targetWakeMinutes,
        targetWakeTime: formatClockMinutes(this.targetWakeMinutes),
        optimalBedtimeMinutes,
        optimalBedtime: formatClockMinutes(optimalBedtimeMinutes),
        sleepNeedMinutes,
        sleepDebtMinutes,
        napCreditMinutes: 0,
        alarmEnabled: this.alarmEnabled,
      },
    };
  }

  async getHeartHistory(range: HistoryRange): Promise<HeartHistorySnapshot> {
    await this.wait();

    return {
      restingHr: 48,
      averageHr: intradayAverageHr,
      maxHr: intradayMaxHr,
      intraday: intradayHeartSeries,
      intradayMarkers,
      weeklyResting: takeTail(series(scoreLabels, restingHrTrend), range),
      recoveryShift: -4,
    };
  }

  async getWellnessSnapshot(range: HistoryRange): Promise<WellnessSnapshot> {
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
      activities,
    };
  }

  async setTargetWakeMinutes(minutes: number): Promise<void> {
    await this.wait();
    this.targetWakeMinutes = roundClockMinutes(minutes);
    this.alarmEnabled = false;
  }

  async enableAlarm(targetWakeMinutes: number): Promise<void> {
    await this.wait();
    this.targetWakeMinutes = roundClockMinutes(targetWakeMinutes);
    this.alarmEnabled = true;
  }

  async disableAlarm(targetWakeMinutes: number): Promise<void> {
    await this.wait();
    this.targetWakeMinutes = roundClockMinutes(targetWakeMinutes);
    this.alarmEnabled = false;
  }
}
