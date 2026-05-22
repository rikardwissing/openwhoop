# @btwearable/local-sqlite-apollo

Read-only Apollo Client for a local SQLite database. The package introspects SQLite at runtime, builds a GraphQL schema from tables/views, and executes GraphQL operations in process against SQLite.

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

The SQLite adapter only needs `getAllAsync` and `getFirstAsync`, so `expo-sqlite` works structurally without package-specific code.

## Generated Query Shape

- `<table_name>(where, order_by, limit, offset): [Sqlite_<table_name>!]!`
- `<table_name>_by_pk(...)` for tables/views with primary key metadata
- Supported comparisons: `_eq`, `_neq`, `_gt`, `_gte`, `_lt`, `_lte`, `_in`, `_like`, `_is_null`
- Logical filters: `_and`, `_or`

Default `limit` is `100`; max `limit` is `10000` unless overridden.
