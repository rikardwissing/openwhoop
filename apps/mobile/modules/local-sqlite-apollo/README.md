# @btwearable/local-sqlite-apollo

Apollo Client for a local SQLite database. The package introspects SQLite at runtime, builds a GraphQL schema from tables/views, and executes GraphQL operations in process against SQLite.

## Usage

```ts
import { gql } from '@apollo/client';
import { getSQLiteApolloClient } from '@btwearable/local-sqlite-apollo';

const client = await getSQLiteApolloClient(db);
const result = await client.query({
  query: gql`
    query LatestRows {
      heart_rate(order_by: [{ time: desc }], limit: 5) {
        id
        time
        bpm
      }
    }
  `,
});
```

The SQLite adapter needs `getAllAsync`, `getFirstAsync`, and `runAsync`, so `expo-sqlite` works structurally without package-specific code.

## Generated Query Shape

- `<table_name>(where, order_by, limit, offset): [Sqlite_<table_name>!]!`
- `<table_name>_by_pk(...)` for tables/views with primary key metadata
- Supported comparisons: `_eq`, `_neq`, `_gt`, `_gte`, `_lt`, `_lte`, `_in`, `_like`, `_is_null`
- Logical filters: `_and`, `_or`

Default `limit` is `100`; max `limit` is `10000` unless overridden.

## Generated Mutation Shape

Mutations are generated for SQLite tables only, not views.

- `insert_<table_name>(objects: [Sqlite_<table_name>_insert_input!]!): Sqlite_<table_name>_mutation_response!`
- `insert_<table_name>_one(object: Sqlite_<table_name>_insert_input!): Sqlite_<table_name>`
- `update_<table_name>(where, _set): Sqlite_<table_name>_mutation_response!`
- `update_<table_name>_by_pk(pk_columns, _set): Sqlite_<table_name>` for tables with primary key metadata

Mutation responses include `affected_rows` and `returning`. Returned rows are re-read after the write by primary key when possible, avoiding a dependency on SQLite `RETURNING` support.

Insert mutations also support Hasura-style `on_conflict` for primary keys and non-partial unique indexes:

```graphql
mutation UpsertExample($object: Sqlite_example_insert_input!) {
  insert_example_one(
    object: $object
    on_conflict: {
      constraint: example_name_key
      update_columns: [value, updated_at]
    }
  ) {
    id
  }
}
```

Use an empty `update_columns` array to ignore conflicts. Constraint enum names are generated as `<table>_pkey` for primary keys and `<table>_<column>_key` for unique indexes.
