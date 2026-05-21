import {
  ApolloClient,
  ApolloLink,
  InMemoryCache,
  Observable,
  type FetchResult,
  type TypePolicies,
} from '@apollo/client/core';
import type { SQLiteBindValue, SQLiteDatabase } from 'expo-sqlite';
import {
  execute as executeGraphQL,
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfigMap,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLScalarType,
} from 'graphql';

const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 10_000;
const GRAPHQL_NAME_PATTERN = /^[_A-Za-z][_0-9A-Za-z]*$/;
const sqliteApolloClients = new WeakMap<SQLiteDatabase, Promise<ApolloClient>>();

interface PragmaTableListRow {
  schema: string;
  name: string;
  type: 'table' | 'view' | 'shadow' | 'virtual';
}

interface PragmaTableInfoRow {
  name: string;
  type: string | null;
  notnull: number;
  pk: number;
  hidden?: number;
}

interface PragmaIndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface PragmaForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
}

interface SqliteColumnMetadata {
  graphQLType: GraphQLScalarType;
  name: string;
  notNull: boolean;
  pkOrder: number;
  sqliteType: string;
}

interface SqliteTableMetadata {
  columns: SqliteColumnMetadata[];
  columnNames: Set<string>;
  foreignKeys: PragmaForeignKeyRow[];
  indexes: PragmaIndexListRow[];
  kind: 'table' | 'view';
  name: string;
  pkColumns: SqliteColumnMetadata[];
  typeName: string;
}

interface SqliteSchemaMetadata {
  tables: SqliteTableMetadata[];
  tablesByName: Map<string, SqliteTableMetadata>;
}

type QueryArgs = {
  limit?: number | null;
  offset?: number | null;
  order_by?: Array<Record<string, 'asc' | 'desc' | null> | null> | null;
  where?: Record<string, unknown> | null;
};

function toSqliteBindValue(value: unknown): SQLiteBindValue {
  if (typeof value === 'number' || typeof value === 'string' || value === null) {
    return value;
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  return String(value);
}

function isGraphQLName(value: string) {
  return GRAPHQL_NAME_PATTERN.test(value) && !value.startsWith('__');
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteSqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqliteTypeToGraphQLScalar(type: string | null | undefined): GraphQLScalarType {
  const normalized = (type ?? '').toUpperCase();

  if (normalized.includes('INT')) {
    return GraphQLInt;
  }

  if (
    normalized.includes('REAL') ||
    normalized.includes('FLOA') ||
    normalized.includes('DOUB') ||
    normalized.includes('NUM')
  ) {
    return GraphQLFloat;
  }

  if (normalized.includes('BOOL')) {
    return GraphQLBoolean;
  }

  return GraphQLString;
}

function tableTypeName(tableName: string) {
  return `Sqlite_${tableName}`;
}

async function loadSqliteTables(db: SQLiteDatabase): Promise<PragmaTableListRow[]> {
  try {
    return await db.getAllAsync<PragmaTableListRow>('PRAGMA table_list');
  } catch {
    const rows = await db.getAllAsync<{ name: string; type: 'table' | 'view' }>(
      `
        SELECT name, type
        FROM sqlite_schema
        WHERE type IN ('table', 'view')
        ORDER BY name ASC
      `,
    );

    return rows.map((row) => ({
      schema: 'main',
      name: row.name,
      type: row.type,
    }));
  }
}

async function loadSqliteColumns(db: SQLiteDatabase, tableName: string): Promise<PragmaTableInfoRow[]> {
  try {
    return await db.getAllAsync<PragmaTableInfoRow>(`PRAGMA table_xinfo(${quoteSqlString(tableName)})`);
  } catch {
    return db.getAllAsync<PragmaTableInfoRow>(`PRAGMA table_info(${quoteSqlString(tableName)})`);
  }
}

async function introspectSqliteSchema(db: SQLiteDatabase): Promise<SqliteSchemaMetadata> {
  const tableRows = await loadSqliteTables(db);
  const tables: SqliteTableMetadata[] = [];

  for (const tableRow of tableRows) {
    if (
      tableRow.schema !== 'main' ||
      (tableRow.type !== 'table' && tableRow.type !== 'view') ||
      tableRow.name.startsWith('sqlite_') ||
      !isGraphQLName(tableRow.name)
    ) {
      continue;
    }

    const columnRows = await loadSqliteColumns(db, tableRow.name);
    const columns = columnRows
      .filter((column) => (column.hidden ?? 0) === 0 && isGraphQLName(column.name))
      .map((column): SqliteColumnMetadata => ({
        graphQLType: sqliteTypeToGraphQLScalar(column.type),
        name: column.name,
        notNull: column.notnull === 1,
        pkOrder: column.pk,
        sqliteType: column.type ?? '',
      }));

    if (columns.length === 0) {
      continue;
    }

    const [indexes, foreignKeys] = await Promise.all([
      db.getAllAsync<PragmaIndexListRow>(`PRAGMA index_list(${quoteSqlString(tableRow.name)})`).catch(() => []),
      db.getAllAsync<PragmaForeignKeyRow>(`PRAGMA foreign_key_list(${quoteSqlString(tableRow.name)})`).catch(() => []),
    ]);

    tables.push({
      columns,
      columnNames: new Set(columns.map((column) => column.name)),
      foreignKeys,
      indexes,
      kind: tableRow.type,
      name: tableRow.name,
      pkColumns: columns.filter((column) => column.pkOrder > 0).sort((left, right) => left.pkOrder - right.pkOrder),
      typeName: tableTypeName(tableRow.name),
    });
  }

  return {
    tables,
    tablesByName: new Map(tables.map((table) => [table.name, table])),
  };
}

function clampLimit(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_QUERY_LIMIT;
  }

  return Math.max(0, Math.min(MAX_QUERY_LIMIT, Math.floor(value)));
}

function clampOffset(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function appendComparisonSql(
  columnSql: string,
  comparison: Record<string, unknown>,
  sqlParts: string[],
  params: SQLiteBindValue[],
) {
  for (const [operator, value] of Object.entries(comparison)) {
    switch (operator) {
      case '_eq':
        if (value === null) {
          sqlParts.push(`${columnSql} IS NULL`);
        } else {
          sqlParts.push(`${columnSql} = ?`);
          params.push(toSqliteBindValue(value));
        }
        break;
      case '_neq':
        if (value === null) {
          sqlParts.push(`${columnSql} IS NOT NULL`);
        } else {
          sqlParts.push(`${columnSql} <> ?`);
          params.push(toSqliteBindValue(value));
        }
        break;
      case '_gt':
        sqlParts.push(`${columnSql} > ?`);
        params.push(toSqliteBindValue(value));
        break;
      case '_gte':
        sqlParts.push(`${columnSql} >= ?`);
        params.push(toSqliteBindValue(value));
        break;
      case '_lt':
        sqlParts.push(`${columnSql} < ?`);
        params.push(toSqliteBindValue(value));
        break;
      case '_lte':
        sqlParts.push(`${columnSql} <= ?`);
        params.push(toSqliteBindValue(value));
        break;
      case '_like':
        sqlParts.push(`${columnSql} LIKE ?`);
        params.push(toSqliteBindValue(value));
        break;
      case '_in': {
        const values = Array.isArray(value) ? value : [];
        if (values.length === 0) {
          sqlParts.push('0');
        } else {
          sqlParts.push(`${columnSql} IN (${values.map(() => '?').join(', ')})`);
          params.push(...values.map(toSqliteBindValue));
        }
        break;
      }
      case '_is_null':
        sqlParts.push(value ? `${columnSql} IS NULL` : `${columnSql} IS NOT NULL`);
        break;
    }
  }
}

function buildWhereSql(
  table: SqliteTableMetadata,
  where: Record<string, unknown> | null | undefined,
  params: SQLiteBindValue[],
): string | null {
  if (!where) {
    return null;
  }

  const sqlParts: string[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (key === '_and' || key === '_or') {
      const children = (Array.isArray(value) ? value : [])
        .map((child) => buildWhereSql(table, child as Record<string, unknown>, params))
        .filter((child): child is string => Boolean(child));

      if (children.length > 0) {
        sqlParts.push(`(${children.join(key === '_and' ? ' AND ' : ' OR ')})`);
      }
      continue;
    }

    if (!table.columnNames.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    appendComparisonSql(quoteIdentifier(key), value as Record<string, unknown>, sqlParts, params);
  }

  return sqlParts.length > 0 ? sqlParts.map((part) => `(${part})`).join(' AND ') : null;
}

function buildOrderBySql(table: SqliteTableMetadata, orderBy: QueryArgs['order_by']) {
  const clauses: string[] = [];

  for (const entry of orderBy ?? []) {
    if (!entry) {
      continue;
    }

    for (const [columnName, direction] of Object.entries(entry)) {
      if (!table.columnNames.has(columnName) || (direction !== 'asc' && direction !== 'desc')) {
        continue;
      }

      clauses.push(`${quoteIdentifier(columnName)} ${direction.toUpperCase()}`);
    }
  }

  return clauses.length > 0 ? ` ORDER BY ${clauses.join(', ')}` : '';
}

async function selectTableRows(db: SQLiteDatabase, table: SqliteTableMetadata, args: QueryArgs) {
  const params: SQLiteBindValue[] = [];
  const whereSql = buildWhereSql(table, args.where, params);
  const sql = [
    `SELECT * FROM ${quoteIdentifier(table.name)}`,
    whereSql ? ` WHERE ${whereSql}` : '',
    buildOrderBySql(table, args.order_by),
    ` LIMIT ${clampLimit(args.limit)}`,
    ` OFFSET ${clampOffset(args.offset)}`,
  ].join('');

  return db.getAllAsync(sql, ...params);
}

async function selectTableRowByPk(db: SQLiteDatabase, table: SqliteTableMetadata, args: Record<string, unknown>) {
  const params: SQLiteBindValue[] = [];
  const whereSql = table.pkColumns.map((column) => {
    params.push(toSqliteBindValue(args[column.name]));
    return `${quoteIdentifier(column.name)} = ?`;
  }).join(' AND ');

  return db.getFirstAsync(`SELECT * FROM ${quoteIdentifier(table.name)} WHERE ${whereSql} LIMIT 1`, ...params);
}

function buildSQLiteGraphQLSchema(db: SQLiteDatabase, metadata: SqliteSchemaMetadata) {
  const orderByDirection = new GraphQLEnumType({
    name: 'order_by',
    values: {
      asc: { value: 'asc' },
      desc: { value: 'desc' },
    },
  });
  const objectTypes = new Map<string, GraphQLObjectType>();
  const whereTypes = new Map<string, GraphQLInputObjectType>();
  const orderTypes = new Map<string, GraphQLInputObjectType>();
  const comparisonTypes = new Map<string, GraphQLInputObjectType>();

  const comparisonType = (table: SqliteTableMetadata, column: SqliteColumnMetadata) => {
    const key = `${table.name}.${column.name}`;
    const existing = comparisonTypes.get(key);
    if (existing) {
      return existing;
    }

    const type = new GraphQLInputObjectType({
      name: `${table.typeName}_${column.name}_comparison_exp`,
      fields: {
        _eq: { type: column.graphQLType },
        _neq: { type: column.graphQLType },
        _gt: { type: column.graphQLType },
        _gte: { type: column.graphQLType },
        _lt: { type: column.graphQLType },
        _lte: { type: column.graphQLType },
        _in: { type: new GraphQLList(column.graphQLType) },
        _like: { type: GraphQLString },
        _is_null: { type: GraphQLBoolean },
      },
    });

    comparisonTypes.set(key, type);
    return type;
  };

  const objectType = (table: SqliteTableMetadata): GraphQLObjectType => {
    const existing = objectTypes.get(table.name);
    if (existing) {
      return existing;
    }

    const type = new GraphQLObjectType({
      name: table.typeName,
      fields: () =>
        Object.fromEntries(
          table.columns.map((column) => [column.name, { type: column.graphQLType as GraphQLOutputType }]),
        ),
    });

    objectTypes.set(table.name, type);
    return type;
  };

  const whereInputType = (table: SqliteTableMetadata): GraphQLInputObjectType => {
    const existing = whereTypes.get(table.name);
    if (existing) {
      return existing;
    }

    const type = new GraphQLInputObjectType({
      name: `${table.typeName}_bool_exp`,
      fields: () => {
        const fields: GraphQLInputFieldConfigMap = {
          _and: { type: new GraphQLList(new GraphQLNonNull(type)) },
          _or: { type: new GraphQLList(new GraphQLNonNull(type)) },
        };

        for (const column of table.columns) {
          fields[column.name] = { type: comparisonType(table, column) };
        }

        return fields;
      },
    });

    whereTypes.set(table.name, type);
    return type;
  };

  const orderInputType = (table: SqliteTableMetadata): GraphQLInputObjectType => {
    const existing = orderTypes.get(table.name);
    if (existing) {
      return existing;
    }

    const type = new GraphQLInputObjectType({
      name: `${table.typeName}_order_by`,
      fields: Object.fromEntries(
        table.columns.map((column) => [column.name, { type: orderByDirection as GraphQLInputType }]),
      ),
    });

    orderTypes.set(table.name, type);
    return type;
  };

  const queryFields: GraphQLFieldConfigMap<unknown, unknown> = {};

  for (const table of metadata.tables) {
    queryFields[table.name] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType(table)))),
      args: {
        where: { type: whereInputType(table) },
        order_by: { type: new GraphQLList(new GraphQLNonNull(orderInputType(table))) },
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
      },
      resolve: (_source, args) => selectTableRows(db, table, args as QueryArgs),
    };

    if (table.pkColumns.length > 0) {
      queryFields[`${table.name}_by_pk`] = {
        type: objectType(table),
        args: Object.fromEntries(
          table.pkColumns.map((column) => [column.name, { type: new GraphQLNonNull(column.graphQLType) }]),
        ),
        resolve: (_source, args) => selectTableRowByPk(db, table, args as Record<string, unknown>),
      };
    }
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: queryFields,
    }),
  });
}

function createSQLiteGraphQLLink(schema: GraphQLSchema) {
  return new ApolloLink((operation) =>
    new Observable<FetchResult>((observer) => {
      Promise.resolve(executeGraphQL({
        schema,
        document: operation.query,
        operationName: operation.operationName,
        variableValues: operation.variables,
      }))
        .then((result) => {
          observer.next(result);
          observer.complete();
        })
        .catch((error) => {
          observer.error(error);
        });
    }),
  );
}

function buildTypePolicies(metadata: SqliteSchemaMetadata): TypePolicies {
  const policies: TypePolicies = {};

  for (const table of metadata.tables) {
    policies[table.typeName] = {
      keyFields: table.pkColumns.length === 1 ? [table.pkColumns[0]!.name] : false,
    };
  }

  return policies;
}

export async function createSQLiteApolloClient(db: SQLiteDatabase): Promise<ApolloClient> {
  const metadata = await introspectSqliteSchema(db);
  const schema = buildSQLiteGraphQLSchema(db, metadata);

  return new ApolloClient({
    cache: new InMemoryCache({
      typePolicies: buildTypePolicies(metadata),
    }),
    link: createSQLiteGraphQLLink(schema),
  });
}

export function getSQLiteApolloClient(db: SQLiteDatabase): Promise<ApolloClient> {
  const existing = sqliteApolloClients.get(db);
  if (existing) {
    return existing;
  }

  const next = createSQLiteApolloClient(db);
  sqliteApolloClients.set(db, next);
  return next;
}
