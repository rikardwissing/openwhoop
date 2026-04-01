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
                    .add_column(ColumnDef::new(HeartRate::Spo2).double().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(HeartRate::Table)
                    .drop_column(HeartRate::Spo2)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum HeartRate {
    Table,
    Spo2,
}
