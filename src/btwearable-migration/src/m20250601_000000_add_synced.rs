use sea_orm_migration::prelude::*;

use crate::m20250111_123805_heart_rate::HeartRate;
use crate::m20250127_195808_sleep_cycles::SleepCycles;
use crate::m20250202_085524_activities::Activities;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(HeartRate::Table)
                    .add_column(
                        ColumnDef::new(Synced::Synced)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(SleepCycles::Table)
                    .add_column(
                        ColumnDef::new(Synced::Synced)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Activities::Table)
                    .add_column(
                        ColumnDef::new(Synced::Synced)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(HeartRate::Table)
                    .drop_column(Synced::Synced)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(SleepCycles::Table)
                    .drop_column(Synced::Synced)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Activities::Table)
                    .drop_column(Synced::Synced)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum Synced {
    Synced,
}
