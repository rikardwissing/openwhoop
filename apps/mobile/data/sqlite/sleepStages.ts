import type { SleepStage } from '@/types/health';
import { clamp, mean, median } from '@/utils/math';

const PPG_AWAKE_THRESHOLD = 22888;
const PPG_SATURATION_THRESHOLD = 40000;

const EPOCH_30S_MS = 30_000;
const EPOCH_60S_MS = 60_000;
const EPOCH_120S_MS = 120_000;
const EPOCH_300S_MS = 300_000;
const EPOCH_600S_MS = 600_000;
const MAX_SLEEP_BRIDGE_STAGE_MINUTES = 2;
const MAX_AWAKE_BRIDGE_STAGE_MINUTES = 1.5;
const LATE_AWAKE_BRIDGE_FRACTION = 0.75;

export interface SleepStageInputRow {
  date: Date;
  bpm: number;
  rr: number[];
  ppgGreen: number | null;
  gravity: [number, number, number] | null;
  skinContact: number | null;
  signalQuality: number | null;
}

export interface DerivedSleepStageRecord {
  start: Date;
  end: Date;
  stage: SleepStage;
  isEstimated: boolean;
  confidence: number;
}

interface SleepStageEpoch {
  start: Date;
  end: Date;
  avgBpm: number;
  medianPpg: number;
  maxPpg: number;
  awakePpgRatio: number;
  saturatedPpgRatio: number;
  motionScore: number;
  postureCentroid: [number, number, number] | null;
  postureShift: number;
  rmssd: number | null;
  contactRatio: number;
  signalQualityPresentRatio: number;
  elapsedFraction: number;
  ppgHint: SleepStage;
  stage: SleepStage;
  confidence: number;
}

interface StageScore {
  stage: SleepStage;
  score: number;
}

interface SleepStageContext {
  ppgQ10: number;
  ppgQ25: number;
  ppgQ50: number;
  ppgQ75: number;
  ppgQ85: number;
  bpmQ20: number;
  bpmQ25: number;
  bpmQ50: number;
  bpmQ75: number;
  bpmQ90: number;
  rmssdQ25: number | null;
  rmssdQ75: number | null;
  motionQ50: number;
  motionQ90: number;
}

function exactMinutesBetween(start: Date, end: Date) {
  return Math.max(0, (end.getTime() - start.getTime()) / 60000);
}

function gravityDelta(left: [number, number, number] | null, right: [number, number, number] | null) {
  if (!left || !right) {
    return 0;
  }

  const dx = left[0] - right[0];
  const dy = left[1] - right[1];
  const dz = left[2] - right[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function rrToRmssd(rr: number[]) {
  if (rr.length < 2) {
    return null;
  }

  const squaredDiffs: number[] = [];
  for (let index = 1; index < rr.length; index += 1) {
    const difference = rr[index] - rr[index - 1];
    squaredDiffs.push(difference * difference);
  }

  return Math.sqrt(mean(squaredDiffs));
}

function quantile(values: number[], percentile: number) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = clamp(percentile, 0, 1) * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }

  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

function buildStageContext(epochs: readonly SleepStageEpoch[]): SleepStageContext {
  const ppgValues = epochs.map((epoch) => epoch.medianPpg);
  const bpmValues = epochs.map((epoch) => epoch.avgBpm);
  const motionValues = epochs.map((epoch) => epoch.motionScore);
  const rmssdValues = epochs
    .map((epoch) => epoch.rmssd)
    .filter((value): value is number => value !== null);

  const ppgMedian = median(ppgValues) ?? 0;
  const bpmMedian = median(bpmValues) ?? 0;
  const motionMedian = median(motionValues) ?? 0;

  return {
    ppgQ10: quantile(ppgValues, 0.1) ?? ppgMedian,
    ppgQ25: quantile(ppgValues, 0.25) ?? ppgMedian,
    ppgQ50: ppgMedian,
    ppgQ75: quantile(ppgValues, 0.75) ?? ppgMedian,
    ppgQ85: quantile(ppgValues, 0.85) ?? ppgMedian,
    bpmQ20: quantile(bpmValues, 0.2) ?? bpmMedian,
    bpmQ25: quantile(bpmValues, 0.25) ?? bpmMedian,
    bpmQ50: bpmMedian,
    bpmQ75: quantile(bpmValues, 0.75) ?? bpmMedian,
    bpmQ90: quantile(bpmValues, 0.9) ?? bpmMedian,
    rmssdQ25: quantile(rmssdValues, 0.25),
    rmssdQ75: quantile(rmssdValues, 0.75),
    motionQ50: quantile(motionValues, 0.5) ?? motionMedian,
    motionQ90: quantile(motionValues, 0.9) ?? motionMedian,
  };
}

function classifyPpgHint(ppgGreen: number, context: SleepStageContext): SleepStage {
  if (ppgGreen <= context.ppgQ25) {
    return 'deep';
  }

  if (ppgGreen >= context.ppgQ50) {
    return 'rem';
  }

  return 'light';
}

export function isAwakePpgValue(ppgGreen: number) {
  return ppgGreen >= PPG_AWAKE_THRESHOLD;
}

function resolveEpochDurationMs(rows: readonly SleepStageInputRow[]) {
  const gaps: number[] = [];

  for (let index = 1; index < rows.length; index += 1) {
    const gapMs = rows[index].date.getTime() - rows[index - 1].date.getTime();
    if (gapMs > 0) {
      gaps.push(gapMs);
    }
  }

  const medianGapMs = median(gaps) ?? EPOCH_30S_MS;
  if (medianGapMs <= 2_000) {
    return EPOCH_30S_MS;
  }

  if (medianGapMs <= 10_000) {
    return EPOCH_60S_MS;
  }

  if (medianGapMs <= 30_000) {
    return EPOCH_120S_MS;
  }

  if (medianGapMs <= 120_000) {
    return EPOCH_300S_MS;
  }

  return Math.min(EPOCH_600S_MS, Math.max(EPOCH_300S_MS, Math.round(medianGapMs / 60000) * 60000));
}

function buildEpochs(rows: readonly SleepStageInputRow[]) {
  const filteredRows = rows
    .filter((row): row is SleepStageInputRow & { ppgGreen: number } => row.ppgGreen !== null)
    .sort((left, right) => left.date.getTime() - right.date.getTime());

  if (filteredRows.length === 0) {
    return {
      epochDurationMs: EPOCH_30S_MS,
      epochs: [] as SleepStageEpoch[],
    };
  }

  const epochDurationMs = resolveEpochDurationMs(filteredRows);
  const originMs = filteredRows[0].date.getTime();
  const epochBuckets = new Map<number, Array<SleepStageInputRow & { ppgGreen: number }>>();

  for (const row of filteredRows) {
    const bucketIndex = Math.floor((row.date.getTime() - originMs) / epochDurationMs);
    const bucket = epochBuckets.get(bucketIndex) ?? [];
    bucket.push(row);
    epochBuckets.set(bucketIndex, bucket);
  }

  const sortedBucketIndexes = [...epochBuckets.keys()].sort((left, right) => left - right);
  const epochs: SleepStageEpoch[] = sortedBucketIndexes.map((bucketIndex) => {
    const bucketRows = epochBuckets.get(bucketIndex)!;
    const ppgValues = bucketRows.map((row) => row.ppgGreen);
    const medianPpg = median(ppgValues) ?? 0;
    const maxPpg = ppgValues.reduce((highest, value) => (value > highest ? value : highest), ppgValues[0] ?? 0);
    const awakePpgRatio = ppgValues.filter((value) => value >= PPG_AWAKE_THRESHOLD).length / Math.max(ppgValues.length, 1);
    const saturatedPpgRatio = ppgValues.filter((value) => value >= PPG_SATURATION_THRESHOLD).length / Math.max(ppgValues.length, 1);
    const bpmValues = bucketRows.map((row) => row.bpm);
    const rrValues = bucketRows.flatMap((row) => row.rr).filter((value) => value > 0);
    const motionValues: number[] = [];

    for (let index = 1; index < bucketRows.length; index += 1) {
      motionValues.push(gravityDelta(bucketRows[index - 1].gravity, bucketRows[index].gravity));
    }

    const gravityRows = bucketRows.filter((row) => row.gravity !== null);
    const postureCentroid = gravityRows.length === 0
      ? null
      : [
          mean(gravityRows.map((row) => row.gravity![0])),
          mean(gravityRows.map((row) => row.gravity![1])),
          mean(gravityRows.map((row) => row.gravity![2])),
        ] as [number, number, number];
    const contactValues = bucketRows.filter((row) => row.skinContact !== null).map((row) => row.skinContact!);
    const signalQualityValues = bucketRows.filter((row) => row.signalQuality !== null).map((row) => row.signalQuality!);

    return {
      start: bucketRows[0].date,
      end: bucketRows[bucketRows.length - 1].date,
      avgBpm: mean(bpmValues),
      medianPpg,
      maxPpg,
      awakePpgRatio,
      saturatedPpgRatio,
      motionScore: motionValues.length === 0 ? 0 : mean(motionValues),
      postureCentroid,
      postureShift: 0,
      rmssd: rrToRmssd(rrValues),
      contactRatio: contactValues.length === 0 ? 1 : contactValues.filter((value) => value > 0).length / contactValues.length,
      signalQualityPresentRatio:
        signalQualityValues.length === 0
          ? 1
          : signalQualityValues.filter((value) => value > 0).length / signalQualityValues.length,
      elapsedFraction: 0,
      ppgHint: 'light',
      stage: 'light',
      confidence: 0,
    };
  });

  const totalDurationMs = Math.max(1, epochs[epochs.length - 1]!.end.getTime() - epochs[0]!.start.getTime());
  for (let index = 0; index < epochs.length; index += 1) {
    epochs[index].elapsedFraction = clamp(
      (epochs[index].start.getTime() - epochs[0]!.start.getTime()) / totalDurationMs,
      0,
      1,
    );
    epochs[index].postureShift = gravityDelta(epochs[index - 1]?.postureCentroid ?? null, epochs[index].postureCentroid);
  }

  return {
    epochDurationMs,
    epochs,
  };
}

function scoreEpoch(
  epoch: SleepStageEpoch,
  context: SleepStageContext,
  recentAwakeEpochs: number,
) {
  const artifactAwakeSpike =
    epoch.maxPpg >= PPG_SATURATION_THRESHOLD &&
    epoch.awakePpgRatio < 0.15 &&
    epoch.medianPpg < context.ppgQ85;
  const lowMotion = epoch.motionScore <= context.motionQ50;
  const highMotion = epoch.motionScore >= Math.max(0.03, context.motionQ90);
  const mediumMotion = !lowMotion && !highMotion;
  const postureChange = epoch.postureShift >= 0.12;
  const ppgVeryLow = epoch.medianPpg <= context.ppgQ10;
  const ppgLow = epoch.medianPpg <= context.ppgQ25;
  const ppgMidHigh = epoch.medianPpg >= context.ppgQ50;
  const ppgHigh = epoch.medianPpg >= context.ppgQ75;
  const ppgVeryHigh = epoch.medianPpg >= context.ppgQ85;
  const hrVeryLow = epoch.avgBpm <= context.bpmQ20;
  const hrLow = epoch.avgBpm <= context.bpmQ25;
  const hrMidHigh = epoch.avgBpm >= context.bpmQ50;
  const hrHigh = epoch.avgBpm >= context.bpmQ75;
  const hrVeryHigh = epoch.avgBpm >= context.bpmQ90;
  const higherHrv = context.rmssdQ75 !== null && epoch.rmssd !== null && epoch.rmssd >= context.rmssdQ75;
  const lowerHrv = context.rmssdQ25 !== null && epoch.rmssd !== null && epoch.rmssd <= context.rmssdQ25;

  const awakeScore =
    (epoch.contactRatio < 0.25 ? 2.5 : 0) +
    (highMotion ? 1.25 : 0) +
    (postureChange ? 0.85 : 0) +
    (!artifactAwakeSpike && ppgVeryHigh && hrMidHigh ? 1.35 : 0) +
    (!artifactAwakeSpike && ppgHigh && hrHigh ? 0.9 : 0) +
    (hrVeryHigh ? 0.85 : 0) +
    (recentAwakeEpochs > 0 && ppgMidHigh && hrMidHigh ? 1.25 : 0) +
    (epoch.elapsedFraction >= 0.55 && ppgHigh && hrMidHigh ? 0.55 : 0) -
    (artifactAwakeSpike ? 2.5 : 0);

  const deepScore =
    0.25 +
    (ppgLow ? 1.1 : 0) +
    (ppgVeryLow ? 0.6 : 0) +
    (lowMotion ? 0.35 : 0) +
    (hrLow ? 0.45 : 0) +
    (hrVeryLow ? 0.25 : 0) +
    (higherHrv ? 0.55 : 0) +
    Math.max(0, 0.7 - epoch.elapsedFraction * 1.6);

  const remScore =
    0.45 +
    (ppgMidHigh ? 0.65 : 0) +
    (ppgHigh ? 0.4 : 0) +
    (lowMotion ? 0.4 : 0) +
    (hrMidHigh ? 0.35 : 0) +
    (hrHigh ? 0.5 : 0) +
    (lowerHrv ? 0.4 : 0) +
    Math.max(0, (epoch.elapsedFraction - 0.3) * 1.5) -
    (highMotion ? 0.5 : 0);

  const lightScore =
    0.9 +
    (!ppgLow && !ppgHigh ? 1.0 : 0.25) +
    (!hrLow && !hrHigh ? 0.45 : 0) +
    (mediumMotion ? 0.35 : 0) +
    (!higherHrv && !lowerHrv ? 0.25 : 0) +
    (artifactAwakeSpike ? 1.0 : 0) +
    (epoch.signalQualityPresentRatio < 0.5 ? 0.25 : 0);

  const sleepScores: StageScore[] = [
    { stage: 'deep' as const, score: deepScore },
    { stage: 'rem' as const, score: remScore },
    { stage: 'light' as const, score: lightScore },
  ].sort((left, right) => right.score - left.score);

  const scores: StageScore[] = [...sleepScores, { stage: 'awake' as const, score: awakeScore }].sort((left, right) => right.score - left.score);
  const winning =
    awakeScore >= Math.max(sleepScores[0]?.score ?? 0, 2.35)
      ? { stage: 'awake' as const, score: awakeScore }
      : sleepScores[0]!;
  const runnerUp = scores.find((score) => score.stage !== winning.stage)?.score ?? 0;

  return {
    stage: winning.stage,
    confidence: clamp((winning.score - runnerUp) / 2, 0, 1),
  };
}

function buildRuns(epochs: readonly SleepStageEpoch[]) {
  if (epochs.length === 0) {
    return [] as Array<{ startIndex: number; endIndex: number }>;
  }

  const runs: Array<{ startIndex: number; endIndex: number }> = [];
  let startIndex = 0;

  for (let index = 1; index <= epochs.length; index += 1) {
    const atEnd = index === epochs.length;
    const changed = !atEnd && epochs[index].stage !== epochs[startIndex].stage;

    if (atEnd || changed) {
      runs.push({ startIndex, endIndex: index - 1 });
      startIndex = index;
    }
  }

  return runs;
}

function relabelRun(epochs: SleepStageEpoch[], startIndex: number, endIndex: number, stage: SleepStage) {
  for (let index = startIndex; index <= endIndex; index += 1) {
    epochs[index].stage = stage;
    epochs[index].confidence = Math.min(epochs[index].confidence, 0.4);
  }
}

function smoothEpochStages(epochs: SleepStageEpoch[], epochDurationMs: number) {
  if (epochs.length < 3) {
    return epochs;
  }

  const denseEpochs = epochDurationMs <= EPOCH_60S_MS;
  const runs = buildRuns(epochs);

  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex];
    const previous = runs[runIndex - 1];
    const next = runs[runIndex + 1];
    if (!previous || !next) {
      continue;
    }

    const runStage = epochs[run.startIndex].stage;
    const previousStage = epochs[previous.startIndex].stage;
    const nextStage = epochs[next.startIndex].stage;
    const durationMinutes = exactMinutesBetween(epochs[run.startIndex].start, epochs[run.endIndex].end);
    const averageConfidence = mean(epochs.slice(run.startIndex, run.endIndex + 1).map((epoch) => epoch.confidence));
    const midpointIndex = Math.floor((run.startIndex + run.endIndex) / 2);
    const midpointElapsed = epochs[midpointIndex].elapsedFraction;

    if (
      runStage === 'awake' &&
      denseEpochs &&
      durationMinutes <= 1 &&
      previousStage === nextStage
    ) {
      relabelRun(epochs, run.startIndex, run.endIndex, previousStage);
      continue;
    }

    if (denseEpochs && previousStage === nextStage) {
      if (
        runStage === 'light' &&
        previousStage === 'deep' &&
        durationMinutes <= 3 &&
        midpointElapsed <= 0.55
      ) {
        relabelRun(epochs, run.startIndex, run.endIndex, 'deep');
        continue;
      }

      if (
        runStage === 'deep' &&
        previousStage === 'light' &&
        durationMinutes <= 1.5
      ) {
        relabelRun(epochs, run.startIndex, run.endIndex, 'light');
        continue;
      }

      if (
        runStage === 'light' &&
        previousStage === 'rem' &&
        durationMinutes <= 2 &&
        midpointElapsed >= 0.45
      ) {
        relabelRun(epochs, run.startIndex, run.endIndex, 'rem');
        continue;
      }

      if (
        runStage === 'awake' &&
        previousStage === 'rem' &&
        durationMinutes <= 2 &&
        midpointElapsed >= 0.5
      ) {
        relabelRun(epochs, run.startIndex, run.endIndex, 'rem');
        continue;
      }

      if (
        runStage === 'rem' &&
        previousStage === 'awake' &&
        nextStage === 'awake' &&
        durationMinutes <= 2 &&
        midpointElapsed >= 0.5
      ) {
        relabelRun(epochs, run.startIndex, run.endIndex, 'awake');
        continue;
      }

      if (
        runStage === 'light' &&
        previousStage === 'awake' &&
        nextStage === 'awake' &&
        durationMinutes <= 2 &&
        midpointElapsed >= 0.5
      ) {
        relabelRun(epochs, run.startIndex, run.endIndex, 'awake');
        continue;
      }

      if (
        runStage === 'rem' &&
        previousStage === 'awake' &&
        durationMinutes <= 1 &&
        midpointElapsed >= 0.5
      ) {
        relabelRun(epochs, run.startIndex, run.endIndex, 'awake');
        continue;
      }
    }

    if (
      runStage !== 'awake' &&
      averageConfidence < 0.35 &&
      durationMinutes <= Math.max(1, epochDurationMs / 60000) &&
      previousStage === nextStage
    ) {
      relabelRun(epochs, run.startIndex, run.endIndex, previousStage);
    }
  }

  return epochs;
}

function applyLateWakeLock(
  epochs: SleepStageEpoch[],
  epochDurationMs: number,
  context: SleepStageContext,
) {
  if (epochs.length === 0) {
    return epochs;
  }

  const isWakeLikeEpoch = (epoch: SleepStageEpoch) => (
    epoch.contactRatio < 0.5 ||
    epoch.postureShift >= 0.08 ||
    (epoch.medianPpg >= context.ppgQ50 && epoch.avgBpm >= context.bpmQ50) ||
    (epoch.medianPpg >= context.ppgQ75 && epoch.avgBpm >= context.bpmQ25)
  );
  const isSleepLikeEpoch = (epoch: SleepStageEpoch) => (
    epoch.medianPpg < context.ppgQ50 &&
    epoch.avgBpm < context.bpmQ50 &&
    epoch.motionScore <= context.motionQ50 &&
    epoch.postureShift < 0.05
  );
  const runs = buildRuns(epochs);
  const lateWakeRunIndex = runs.findIndex((run) => {
    if (epochs[run.startIndex].stage !== 'awake') {
      return false;
    }

    const midpointIndex = Math.floor((run.startIndex + run.endIndex) / 2);
    const midpointElapsed = epochs[midpointIndex].elapsedFraction;
    const durationMinutes = exactMinutesBetween(epochs[run.startIndex].start, epochs[run.endIndex].end);

    return midpointElapsed >= 0.58 && durationMinutes >= Math.max(3, epochDurationMs / 60000);
  });

  if (lateWakeRunIndex < 0) {
    return epochs;
  }

  const lateWakeRun = runs[lateWakeRunIndex];

  let lateWakeStartIndex = lateWakeRun.startIndex;
  let backfillRunIndex = lateWakeRunIndex - 1;
  while (backfillRunIndex >= 0) {
    const run = runs[backfillRunIndex];
    const runStage = epochs[run.startIndex].stage;
    const durationMinutes = exactMinutesBetween(epochs[run.startIndex].start, epochs[run.endIndex].end);
    const midpointIndex = Math.floor((run.startIndex + run.endIndex) / 2);
    const midpointEpoch = epochs[midpointIndex];

    if (midpointEpoch.elapsedFraction < 0.58 || runStage === 'deep') {
      break;
    }

    if (runStage === 'rem' && durationMinutes <= 12) {
      lateWakeStartIndex = run.startIndex;
      backfillRunIndex -= 1;
      continue;
    }

    if (runStage === 'light' && durationMinutes <= 5 && isWakeLikeEpoch(midpointEpoch)) {
      lateWakeStartIndex = run.startIndex;
      backfillRunIndex -= 1;
      continue;
    }

    break;
  }

  while (lateWakeStartIndex > 0) {
    const candidate = epochs[lateWakeStartIndex - 1];
    if (candidate.elapsedFraction < 0.58 || candidate.stage === 'deep' || !isWakeLikeEpoch(candidate)) {
      break;
    }

    lateWakeStartIndex -= 1;
  }

  let sleepLikeStreak = 0;
  const sleepLikeEpochThreshold = Math.max(12, Math.round((10 * 60000) / Math.max(epochDurationMs, 1)));

  for (let index = lateWakeStartIndex; index < epochs.length; index += 1) {
    const epoch = epochs[index];
    const wakeLike = isWakeLikeEpoch(epoch);
    const sleepLike = isSleepLikeEpoch(epoch);

    sleepLikeStreak = sleepLike ? sleepLikeStreak + 1 : 0;

    if (sleepLikeStreak >= sleepLikeEpochThreshold) {
      break;
    }

    if (wakeLike && epoch.stage !== 'deep') {
      epoch.stage = 'awake';
      epoch.confidence = Math.max(epoch.confidence, 0.45);
    }
  }

  return epochs;
}

function chooseBridgedSleepStage(previousStage: SleepStage, nextStage: SleepStage, midpointFraction: number): SleepStage {
  if (previousStage === nextStage) {
    return previousStage;
  }

  if (previousStage === 'awake') {
    return nextStage;
  }

  if (nextStage === 'awake') {
    return previousStage;
  }

  if (previousStage === 'light' || nextStage === 'light') {
    return 'light';
  }

  return midpointFraction < 0.45 ? 'deep' : 'rem';
}

function mergeAdjacentStageRecords(records: readonly DerivedSleepStageRecord[]) {
  if (records.length === 0) {
    return [] as DerivedSleepStageRecord[];
  }

  const merged: DerivedSleepStageRecord[] = [];

  for (const record of records) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...record });
      continue;
    }

    const gapMinutes = exactMinutesBetween(previous.end, record.start);
    if (previous.stage !== record.stage || gapMinutes > 5) {
      merged.push({ ...record });
      continue;
    }

    const previousDuration = exactMinutesBetween(previous.start, previous.end);
    const recordDuration = exactMinutesBetween(record.start, record.end);
    const combinedDuration = previousDuration + recordDuration;

    previous.end = record.end;
    previous.isEstimated = previous.isEstimated && record.isEstimated;
    previous.confidence = combinedDuration <= 0
      ? Math.min(previous.confidence, record.confidence)
      : ((previous.confidence * previousDuration) + (record.confidence * recordDuration)) / combinedDuration;
  }

  return merged;
}

function simplifyStageRecords(records: readonly DerivedSleepStageRecord[], epochDurationMs: number) {
  if (records.length < 3) {
    return [...records];
  }

  const denseEpochs = epochDurationMs <= EPOCH_60S_MS;
  const sleepBridgeMaxMinutes = denseEpochs ? MAX_SLEEP_BRIDGE_STAGE_MINUTES : 1;
  const awakeBridgeMaxMinutes = denseEpochs ? MAX_AWAKE_BRIDGE_STAGE_MINUTES : 1;
  const sessionStartMs = records[0].start.getTime();
  const sessionEndMs = records[records.length - 1].end.getTime();
  const sessionDurationMs = Math.max(1, sessionEndMs - sessionStartMs);

  let simplified = mergeAdjacentStageRecords(records);

  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;

    for (let index = 1; index < simplified.length - 1; index += 1) {
      const record = simplified[index];
      const previous = simplified[index - 1];
      const next = simplified[index + 1];
      const durationMinutes = exactMinutesBetween(record.start, record.end);

      if (durationMinutes <= 0) {
        continue;
      }

      const midpointFraction = clamp(
        (((record.start.getTime() + record.end.getTime()) / 2) - sessionStartMs) / sessionDurationMs,
        0,
        1,
      );

      if (record.stage === 'awake') {
        if (
          durationMinutes <= awakeBridgeMaxMinutes &&
          midpointFraction < LATE_AWAKE_BRIDGE_FRACTION &&
          previous.stage !== 'awake' &&
          next.stage !== 'awake'
        ) {
          const targetStage = chooseBridgedSleepStage(previous.stage, next.stage, midpointFraction);
          if (targetStage !== record.stage) {
            record.stage = targetStage;
            record.confidence = Math.min(record.confidence, 0.35);
            changed = true;
          }
        }
        continue;
      }

      if (previous.stage === 'awake' || next.stage === 'awake' || durationMinutes > sleepBridgeMaxMinutes) {
        continue;
      }

      const targetStage = chooseBridgedSleepStage(previous.stage, next.stage, midpointFraction);
      const oneSideLight = previous.stage === 'light' || next.stage === 'light';
      const lowConfidence = record.confidence < 0.55;
      const veryShort = durationMinutes <= Math.max(1, epochDurationMs / 60000);

      if (
        targetStage !== record.stage &&
        (
          previous.stage === next.stage ||
          (oneSideLight && (record.stage !== 'light' || lowConfidence)) ||
          (veryShort && lowConfidence)
        )
      ) {
        record.stage = targetStage;
        record.confidence = Math.min(record.confidence, 0.4);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }

    simplified = mergeAdjacentStageRecords(simplified);
  }

  return simplified;
}

function epochsToStageRecords(epochs: readonly SleepStageEpoch[]) {
  if (epochs.length === 0) {
    return [] as DerivedSleepStageRecord[];
  }

  const records: DerivedSleepStageRecord[] = [];
  let currentStage = epochs[0].stage;
  let currentStart = epochs[0].start;
  let currentEnd = epochs[0].end;
  let currentConfidences = [epochs[0].confidence];

  for (let index = 1; index < epochs.length; index += 1) {
    const epoch = epochs[index];
    const gapMinutes = exactMinutesBetween(currentEnd, epoch.start);

    if (epoch.stage !== currentStage || gapMinutes > 5) {
      records.push({
        start: currentStart,
        end: currentEnd,
        stage: currentStage,
        isEstimated: true,
        confidence: mean(currentConfidences),
      });
      currentStage = epoch.stage;
      currentStart = epoch.start;
      currentEnd = epoch.end;
      currentConfidences = [epoch.confidence];
      continue;
    }

    currentEnd = epoch.end;
    currentConfidences.push(epoch.confidence);
  }

  records.push({
    start: currentStart,
    end: currentEnd,
    stage: currentStage,
    isEstimated: true,
    confidence: mean(currentConfidences),
  });

  return records;
}

export function generateSleepStageRecords(rows: readonly SleepStageInputRow[]) {
  const { epochDurationMs, epochs } = buildEpochs(rows);
  if (epochs.length === 0) {
    return [] as DerivedSleepStageRecord[];
  }

  const context = buildStageContext(epochs);
  let recentAwakeEpochs = 0;

  for (let index = 0; index < epochs.length; index += 1) {
    epochs[index].ppgHint = classifyPpgHint(epochs[index].medianPpg, context);
    const scored = scoreEpoch(epochs[index], context, recentAwakeEpochs);
    epochs[index].stage = scored.stage;
    epochs[index].confidence = scored.confidence;
    recentAwakeEpochs =
      scored.stage === 'awake'
        ? Math.min(recentAwakeEpochs + 2, 6)
        : Math.max(0, recentAwakeEpochs - 1);
  }

  const smoothedEpochs = smoothEpochStages(epochs, epochDurationMs);
  const wakeLockedEpochs = applyLateWakeLock(smoothedEpochs, epochDurationMs, context);
  return simplifyStageRecords(
    epochsToStageRecords(smoothEpochStages(wakeLockedEpochs, epochDurationMs)),
    epochDurationMs,
  );
}