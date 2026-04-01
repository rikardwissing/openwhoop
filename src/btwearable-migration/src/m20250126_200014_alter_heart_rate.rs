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
                    .add_column(ColumnDef::new(HeartRate::Activity).big_integer().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(HeartRate::Table)
                    .drop_column(HeartRate::Activity)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum HeartRate {
    Table,
    Activity, // New column added
}
