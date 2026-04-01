use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(HeartRate::Table)
                    .add_column(ColumnDef::new(HeartRate::Stress).double().null())
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("heart-rate-time-index")
                    .table(HeartRate::Table)
                    .col(HeartRate::Time)
                    .unique()
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name("heart-rate-time-index")
                    .table(HeartRate::Table)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(HeartRate::Table)
                    .drop_column(HeartRate::Stress)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum HeartRate {
    Table,
    Time,
    Stress, // New column added
}
