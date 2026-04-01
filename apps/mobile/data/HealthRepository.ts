import type {
  DashboardSnapshot,
  HeartHistorySnapshot,
  HistoryRange,
  SleepHistorySnapshot,
  WellnessSnapshot,
} from '@/types/health';

export interface HealthRepository {
  getDashboardSnapshot(): Promise<DashboardSnapshot>;
  getSleepHistory(range: HistoryRange): Promise<SleepHistorySnapshot>;
  getHeartHistory(range: HistoryRange): Promise<HeartHistorySnapshot>;
  getWellnessSnapshot(range: HistoryRange): Promise<WellnessSnapshot>;
}
