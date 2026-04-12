import { selectFocusedHeartBucketMinutes } from '@/utils/heartChartDetail';

describe('heartChartDetail', () => {
  it('uses 30-second buckets for short focused runs around 20 minutes', () => {
    expect(selectFocusedHeartBucketMinutes(20, 5)).toBe(0.5);
  });

  it('only uses 15-second buckets when the raw cadence is dense enough', () => {
    expect(selectFocusedHeartBucketMinutes(10, 5)).toBe(0.25);
    expect(selectFocusedHeartBucketMinutes(10, 12)).toBe(0.5);
    expect(selectFocusedHeartBucketMinutes(75, 5)).toBe(1);
    expect(selectFocusedHeartBucketMinutes(180, 5)).toBe(2);
    expect(selectFocusedHeartBucketMinutes(300, 5)).toBe(5);
  });
});