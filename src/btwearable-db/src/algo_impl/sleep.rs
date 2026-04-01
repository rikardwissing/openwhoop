use btwearable_algos::SleepCycle;
use btwearable_entities::sleep_cycles;
use btwearable_types::activities::{ActivityType, SearchActivityPeriods};
use chrono::{NaiveDate, NaiveDateTime, TimeDelta};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, EntityTrait, IntoActiveModel, QueryFilter,
    QueryOrder, Set,
};

use crate::DatabaseHandler;

impl DatabaseHandler {
    pub async fn get_sleep_cycles(
        &self,
        start: Option<NaiveDateTime>,
    ) -> anyhow::Result<Vec<SleepCycle>> {
        let filter = Condition::all().add_option(start.map(|s| sleep_cycles::Column::Start.gte(s)));

        Ok(sleep_cycles::Entity::find()
            .order_by_asc(sleep_cycles::Column::Start)
            .filter(filter)
            .all(&self.db)
            .await?
            .into_iter()
            .map(map_sleep_cycle)
            .collect())
    }

    pub async fn recalculate_sleep_scores(&self) -> anyhow::Result<()> {
        let mut sleeps = self.get_sleep_cycles(None).await?;
        if sleeps.is_empty() {
            return Ok(());
        }

        let mut naps = self
            .search_activities(SearchActivityPeriods::default().with_activity(ActivityType::Nap))
            .await?;
        naps.sort_by_key(|nap| (nap.from, nap.to));

        let mut prior_sleeps = Vec::with_capacity(sleeps.len());
        for sleep in &mut sleeps {
            let nap_window_start = prior_sleeps
                .last()
                .map(|prior: &SleepCycle| prior.end)
                .unwrap_or_else(|| sleep.start - TimeDelta::hours(24));

            let recent_naps = naps
                .iter()
                .copied()
                .filter(|nap| nap.from >= nap_window_start && nap.to <= sleep.start)
                .collect::<Vec<_>>();

            let score = SleepCycle::sleep_score_with_context(
                sleep.start,
                sleep.end,
                &prior_sleeps,
                &recent_naps,
            );

            self.update_sleep_score(sleep.id, score).await?;
            sleep.score = score;
            prior_sleeps.push(*sleep);
        }

        Ok(())
    }

    async fn update_sleep_score(&self, sleep_id: NaiveDate, score: f64) -> anyhow::Result<()> {
        let Some(model) = sleep_cycles::Entity::find()
            .filter(sleep_cycles::Column::SleepId.eq(sleep_id))
            .one(&self.db)
            .await?
        else {
            return Ok(());
        };

        let mut active_model = model.into_active_model();
        active_model.score = Set(Some(score));
        active_model.synced = Set(false);
        active_model.update(&self.db).await?;

        Ok(())
    }
}

fn map_sleep_cycle(value: sleep_cycles::Model) -> SleepCycle {
    SleepCycle {
        id: value.sleep_id,
        start: value.start,
        end: value.end,
        min_bpm: value.min_bpm.try_into().unwrap(),
        max_bpm: value.max_bpm.try_into().unwrap(),
        avg_bpm: value.avg_bpm.try_into().unwrap(),
        min_hrv: value.min_hrv.try_into().unwrap(),
        max_hrv: value.max_hrv.try_into().unwrap(),
        avg_hrv: value.avg_hrv.try_into().unwrap(),
        score: value
            .score
            .unwrap_or(SleepCycle::sleep_score(value.start, value.end)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn map_sleep_cycle_with_score() {
        let model = sleep_cycles::Model {
            id: uuid::Uuid::new_v4(),
            sleep_id: NaiveDate::from_ymd_opt(2025, 1, 2).unwrap(),
            start: NaiveDate::from_ymd_opt(2025, 1, 1)
                .unwrap()
                .and_hms_opt(22, 0, 0)
                .unwrap(),
            end: NaiveDate::from_ymd_opt(2025, 1, 2)
                .unwrap()
                .and_hms_opt(6, 0, 0)
                .unwrap(),
            min_bpm: 50,
            max_bpm: 70,
            avg_bpm: 60,
            min_hrv: 30,
            max_hrv: 80,
            avg_hrv: 55,
            score: Some(95.0),
            synced: false,
        };

        let cycle = map_sleep_cycle(model);
        assert_eq!(cycle.min_bpm, 50);
        assert_eq!(cycle.avg_hrv, 55);
        assert_eq!(cycle.score, 95.0);
    }

    #[test]
    fn map_sleep_cycle_without_score_uses_calculated() {
        let model = sleep_cycles::Model {
            id: uuid::Uuid::new_v4(),
            sleep_id: NaiveDate::from_ymd_opt(2025, 1, 2).unwrap(),
            start: NaiveDate::from_ymd_opt(2025, 1, 1)
                .unwrap()
                .and_hms_opt(22, 0, 0)
                .unwrap(),
            end: NaiveDate::from_ymd_opt(2025, 1, 2)
                .unwrap()
                .and_hms_opt(6, 0, 0)
                .unwrap(),
            min_bpm: 50,
            max_bpm: 70,
            avg_bpm: 60,
            min_hrv: 30,
            max_hrv: 80,
            avg_hrv: 55,
            score: None, // No score stored
            synced: false,
        };

        let cycle = map_sleep_cycle(model);
        // 8 hours / 8 hours = 1.0 -> 100.0
        assert_eq!(cycle.score, 100.0);
    }

    #[tokio::test]
    async fn get_sleep_cycles_empty() {
        let db = DatabaseHandler::new("sqlite::memory:").await;
        let cycles = db.get_sleep_cycles(None).await.unwrap();
        assert!(cycles.is_empty());
    }

    #[tokio::test]
    async fn get_sleep_cycles_returns_inserted() {
        let db = DatabaseHandler::new("sqlite::memory:").await;

        let start = NaiveDate::from_ymd_opt(2025, 1, 1)
            .unwrap()
            .and_hms_opt(22, 0, 0)
            .unwrap();
        let end = NaiveDate::from_ymd_opt(2025, 1, 2)
            .unwrap()
            .and_hms_opt(6, 0, 0)
            .unwrap();

        db.create_sleep(SleepCycle {
            id: end.date(),
            start,
            end,
            min_bpm: 50,
            max_bpm: 70,
            avg_bpm: 60,
            min_hrv: 30,
            max_hrv: 80,
            avg_hrv: 55,
            score: 100.0,
        })
        .await
        .unwrap();

        let cycles = db.get_sleep_cycles(None).await.unwrap();
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0].min_bpm, 50);
    }

    #[tokio::test]
    async fn get_sleep_cycles_with_start_filter() {
        let db = DatabaseHandler::new("sqlite::memory:").await;

        // Insert two sleep cycles
        for day in [1, 3] {
            let start = NaiveDate::from_ymd_opt(2025, 1, day)
                .unwrap()
                .and_hms_opt(22, 0, 0)
                .unwrap();
            let end = NaiveDate::from_ymd_opt(2025, 1, day + 1)
                .unwrap()
                .and_hms_opt(6, 0, 0)
                .unwrap();

            db.create_sleep(SleepCycle {
                id: end.date(),
                start,
                end,
                min_bpm: 50,
                max_bpm: 70,
                avg_bpm: 60,
                min_hrv: 30,
                max_hrv: 80,
                avg_hrv: 55,
                score: 100.0,
            })
            .await
            .unwrap();
        }

        let filter_start = NaiveDate::from_ymd_opt(2025, 1, 2)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();

        let cycles = db.get_sleep_cycles(Some(filter_start)).await.unwrap();
        assert_eq!(cycles.len(), 1); // Only the Jan 3 sleep
    }

    #[tokio::test]
    async fn recalculate_sleep_scores_accounts_for_naps_and_sleep_need() {
        let db = DatabaseHandler::new("sqlite::memory:").await;

        let sleep_1 = SleepCycle {
            id: NaiveDate::from_ymd_opt(2025, 1, 2).unwrap(),
            start: NaiveDate::from_ymd_opt(2025, 1, 1)
                .unwrap()
                .and_hms_opt(22, 0, 0)
                .unwrap(),
            end: NaiveDate::from_ymd_opt(2025, 1, 2)
                .unwrap()
                .and_hms_opt(4, 0, 0)
                .unwrap(),
            min_bpm: 50,
            max_bpm: 70,
            avg_bpm: 60,
            min_hrv: 30,
            max_hrv: 80,
            avg_hrv: 55,
            score: 0.0,
        };
        let sleep_2 = SleepCycle {
            id: NaiveDate::from_ymd_opt(2025, 1, 3).unwrap(),
            start: NaiveDate::from_ymd_opt(2025, 1, 2)
                .unwrap()
                .and_hms_opt(22, 0, 0)
                .unwrap(),
            end: NaiveDate::from_ymd_opt(2025, 1, 3)
                .unwrap()
                .and_hms_opt(5, 0, 0)
                .unwrap(),
            min_bpm: 50,
            max_bpm: 70,
            avg_bpm: 60,
            min_hrv: 30,
            max_hrv: 80,
            avg_hrv: 55,
            score: 0.0,
        };

        db.create_sleep(sleep_1).await.unwrap();
        db.create_sleep(sleep_2).await.unwrap();
        db.create_activity(btwearable_types::activities::ActivityPeriod {
            period_id: sleep_1.id,
            from: NaiveDate::from_ymd_opt(2025, 1, 2)
                .unwrap()
                .and_hms_opt(13, 0, 0)
                .unwrap(),
            to: NaiveDate::from_ymd_opt(2025, 1, 2)
                .unwrap()
                .and_hms_opt(14, 0, 0)
                .unwrap(),
            activity: ActivityType::Nap,
        })
        .await
        .unwrap();

        db.recalculate_sleep_scores().await.unwrap();

        let sleeps = db.get_sleep_cycles(None).await.unwrap();
        assert_eq!(sleeps.len(), 2);
        assert!((sleeps[0].score - 75.0).abs() < 0.000_001);
        assert!((sleeps[1].score - ((7.7 / 9.2) * 100.0)).abs() < 0.000_001);
    }
}
