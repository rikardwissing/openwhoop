import type { HealthRepository } from '@/data/HealthRepository';
import type {
  ActivitySummary,
  DashboardSnapshot,
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

const sessions: SleepSession[] = [
  {
    id: 'sleep-1',
    dateLabel: 'Apr 23',
    score: 82,
    bedtime: '11:07 PM',
    wakeTime: '7:45 AM',
    durationMinutes: 465,
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

const activities: ActivitySummary[] = [
  {
    id: 'activity-1',
    title: 'Tempo Run',
    timeLabel: '7:10 AM',
    durationMinutes: 42,
    strain: 12.4,
    calories: 486,
  },
  {
    id: 'activity-2',
    title: 'Mobility Reset',
    timeLabel: '12:35 PM',
    durationMinutes: 18,
    strain: 3.1,
    calories: 92,
  },
  {
    id: 'activity-3',
    title: 'Evening Walk',
    timeLabel: '6:42 PM',
    durationMinutes: 36,
    strain: 5.4,
    calories: 210,
  },
];

export class MockHealthRepository implements HealthRepository {
  private targetWakeMinutes = 7 * 60 + 45;
  private alarmEnabled = true;

  constructor(private readonly options: { delayMs?: number } = {}) {}

  async warmCaches(): Promise<void> {}

  invalidateCaches(): void {}

  private async wait() {
    await delay(this.options.delayMs ?? 180);
  }

  async getDashboardSnapshot(): Promise<DashboardSnapshot> {
    await this.wait();

    return {
      greeting: 'Good afternoon',
      dateLabel: 'Tuesday, April 23',
      recovery: {
        score: 64,
        label: describeRecovery(64),
        caption: 'Recovery',
      },
      summaryStats: [
        { label: 'HRV', value: '82 ms', accent: 'green' },
        { label: 'RHR', value: '42 bpm', accent: 'cyan' },
        { label: 'Sleep', value: '7h 45m', accent: 'violet' },
      ],
      heartCard: {
        restingHr: 48,
        averageHr: intradayAverageHr,
        maxHr: intradayMaxHr,
        series: dashboardHeartSeries,
      },
      sleepCard: {
        score: 82,
        durationMinutes: 465,
        stages: sessions[0].stages,
        startLabel: '11:07 PM',
        middleLabel: '3:26 AM',
        endLabel: '7:45 AM',
      },
      strainCard: {
        score: 11,
        label: 'Building',
        series: series(
          ['6P', '7P', '8P', '9P', '10P', '11P', '12A', '1A', '2A', '3A', '4A', '5A', '6A', '7A'],
          strainValues
        ),
      },
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
