export const SHOULD_LOG_MOBILE_PERF =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ &&
  (typeof process === 'undefined' || process.env.NODE_ENV !== 'test');

export type PerformanceLogValue = string | number | boolean | null;

function formatMobilePerfSuffix(details?: Record<string, PerformanceLogValue>) {
  return details
    ? Object.entries(details)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
    : '';
}

export function logMobilePerf(label: string, startedAt: number, details?: Record<string, PerformanceLogValue>) {
  if (!SHOULD_LOG_MOBILE_PERF) {
    return;
  }

  const elapsedMs = Date.now() - startedAt;
  const suffix = formatMobilePerfSuffix(details);

  console.info(`[mobile-perf] ${label} ${elapsedMs}ms${suffix ? ` ${suffix}` : ''}`);
}

export function logMobilePerfError(label: string, error: unknown, details?: Record<string, PerformanceLogValue>) {
  if (!SHOULD_LOG_MOBILE_PERF) {
    return;
  }

  const suffix = formatMobilePerfSuffix(details);
  const message = error instanceof Error ? error.message : String(error);

  console.error(`[mobile-perf] ${label} error=${message}${suffix ? ` ${suffix}` : ''}`);
}