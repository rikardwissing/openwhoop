use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SleepCycles::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SleepCycles::Id)
                            .uuid()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SleepCycles::SleepId)
                            .date()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(SleepCycles::Start).date_time().not_null())
                    .col(ColumnDef::new(SleepCycles::End).date_time().not_null())
                    .col(
                        ColumnDef::new(SleepCycles::MinBpm)
                            .small_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SleepCycles::MaxBpm)
                            .small_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SleepCycles::AvgBpm)
                            .small_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(SleepCycles::MinHrv).integer().not_null())
                    .col(ColumnDef::new(SleepCycles::MaxHrv).integer().not_null())
                    .col(ColumnDef::new(SleepCycles::AvgHrv).integer().not_null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SleepCycles::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
pub enum SleepCycles {
    Table,
    Id,
    SleepId,
    Start,
    End,
    MinBpm,
    MaxBpm,
    AvgBpm,
    MinHrv,
    MaxHrv,
    AvgHrv,
}
