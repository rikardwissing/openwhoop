use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(SleepCycles::Table)
                    .add_column(ColumnDef::new(SleepCycles::Score).double().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(SleepCycles::Table)
                    .drop_column(SleepCycles::Score)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum SleepCycles {
    Table,
    Score,
}
