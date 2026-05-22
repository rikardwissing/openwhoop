import {
  ApolloClient,
  ApolloLink,
  InMemoryCache,
  Observable,
  type FetchResult,
  type TypePolicies,
} from '@apollo/client/core';
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
const DEFAULT_TYPE_NAME_PREFIX = 'Sqlite_';
const GRAPHQL_NAME_PATTERN = /^[_A-Za-z][_0-9A-Za-z]*$/;
const sqliteApolloClients = new WeakMap<LocalSQLiteDatabase, Promise<ApolloClient>>();

export type LocalSQLiteBindValue = string | number | null;

export interface LocalSQLiteRunResult {
  changes?: number;
  lastInsertRowId?: number;
}

export interface LocalSQLiteDatabase {
  getAllAsync<T>(sql: string, ...params: LocalSQLiteBindValue[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, ...params: LocalSQLiteBindValue[]): Promise<T | null | undefined>;
  runAsync(sql: string, ...params: LocalSQLiteBindValue[]): Promise<LocalSQLiteRunResult | void>;
}

export interface CreateSQLiteApolloClientOptions {
  defaultLimit?: number;
  maxLimit?: number;
  typeNamePrefix?: string;
}

interface ResolvedOptions {
  defaultLimit: number;
  maxLimit: number;
  typeNamePrefix: string;
}

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

export interface PragmaIndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

export interface PragmaIndexInfoRow {
  cid: number;
  name: string | null;
  seqno: number;
}

export interface PragmaForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
}

export interface SqliteColumnMetadata {
  graphQLType: GraphQLScalarType;
  name: string;
  notNull: boolean;
  pkOrder: number;
  sqliteType: string;
}

export interface SqliteUniqueConstraintMetadata {
  columns: SqliteColumnMetadata[];
  name: string;
}

export interface SqliteTableMetadata {
  columns: SqliteColumnMetadata[];
  columnNames: Set<string>;
  foreignKeys: PragmaForeignKeyRow[];
  indexes: PragmaIndexListRow[];
  kind: 'table' | 'view';
  name: string;
  pkColumns: SqliteColumnMetadata[];
  typeName: string;
  uniqueConstraints: SqliteUniqueConstraintMetadata[];
}

export interface SqliteSchemaMetadata {
  tables: SqliteTableMetadata[];
  tablesByName: Map<string, SqliteTableMetadata>;
}

type QueryArgs = {
  limit?: number | null;
  offset?: number | null;
  order_by?: Array<Record<string, 'asc' | 'desc' | null> | null> | null;
  where?: Record<string, unknown> | null;
};

type OnConflictArgs = {
  constraint: string;
  update_columns: string[];
  where?: Record<string, unknown> | null;
};

type InsertOneArgs = {
  on_conflict?: OnConflictArgs | null;
  object: Record<string, unknown>;
};

type InsertManyArgs = {
  on_conflict?: OnConflictArgs | null;
  objects: Array<Record<string, unknown>>;
};

type UpdateArgs = {
  _set: Record<string, unknown>;
  where: Record<string, unknown>;
};

type UpdateByPkArgs = {
  _set: Record<string, unknown>;
  pk_columns: Record<string, unknown>;
};

type MutationResponse = {
  affected_rows: number;
  returning: unknown[];
};

function resolveOptions(options: CreateSQLiteApolloClientOptions = {}): ResolvedOptions {
  const defaultLimit = Number.isFinite(options.defaultLimit)
    ? Math.max(0, Math.floor(options.defaultLimit!))
    : DEFAULT_QUERY_LIMIT;
  const maxLimit = Number.isFinite(options.maxLimit)
    ? Math.max(0, Math.floor(options.maxLimit!))
    : MAX_QUERY_LIMIT;

  return {
    defaultLimit: Math.min(defaultLimit, maxLimit),
    maxLimit,
    typeNamePrefix: options.typeNamePrefix ?? DEFAULT_TYPE_NAME_PREFIX,
  };
}

function toSqliteBindValue(value: unknown): LocalSQLiteBindValue {
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

function tableTypeName(tableName: string, options: ResolvedOptions) {
  return `${options.typeNamePrefix}${tableName}`;
}

async function loadSqliteTables(db: LocalSQLiteDatabase): Promise<PragmaTableListRow[]> {
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

async function loadSqliteColumns(db: LocalSQLiteDatabase, tableName: string): Promise<PragmaTableInfoRow[]> {
  try {
    return await db.getAllAsync<PragmaTableInfoRow>(`PRAGMA table_xinfo(${quoteSqlString(tableName)})`);
  } catch {
    return db.getAllAsync<PragmaTableInfoRow>(`PRAGMA table_info(${quoteSqlString(tableName)})`);
  }
}

async function loadSqliteIndexColumns(db: LocalSQLiteDatabase, indexName: string): Promise<PragmaIndexInfoRow[]> {
  return db.getAllAsync<PragmaIndexInfoRow>(`PRAGMA index_info(${quoteSqlString(indexName)})`).catch(() => []);
}

function uniqueConstraintName(tableName: string, columns: readonly SqliteColumnMetadata[], suffix: 'pkey' | 'key') {
  return suffix === 'pkey' ? `${tableName}_pkey` : `${tableName}_${columns.map((column) => column.name).join('_')}_key`;
}

async function buildUniqueConstraints(
  db: LocalSQLiteDatabase,
  tableName: string,
  columns: readonly SqliteColumnMetadata[],
  indexes: readonly PragmaIndexListRow[],
) {
  const columnsByName = new Map(columns.map((column) => [column.name, column]));
  const pkColumns = columns.filter((column) => column.pkOrder > 0).sort((left, right) => left.pkOrder - right.pkOrder);
  const constraints: SqliteUniqueConstraintMetadata[] = [];
  const seenColumnSets = new Set<string>();
  const seenNames = new Set<string>();

  const addConstraint = (name: string, constraintColumns: SqliteColumnMetadata[]) => {
    if (constraintColumns.length === 0 || !isGraphQLName(name)) {
      return;
    }

    const columnKey = constraintColumns.map((column) => column.name).join('\0');
    if (seenColumnSets.has(columnKey)) {
      return;
    }

    let resolvedName = name;
    let index = 2;
    while (seenNames.has(resolvedName)) {
      resolvedName = `${name}_${index}`;
      index += 1;
    }

    constraints.push({
      columns: constraintColumns,
      name: resolvedName,
    });
    seenColumnSets.add(columnKey);
    seenNames.add(resolvedName);
  };

  addConstraint(uniqueConstraintName(tableName, pkColumns, 'pkey'), pkColumns);

  for (const index of indexes) {
    if (index.unique !== 1 || index.partial === 1) {
      continue;
    }

    const indexColumns = (await loadSqliteIndexColumns(db, index.name))
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => (row.name ? columnsByName.get(row.name) : undefined));

    if (indexColumns.some((column) => !column)) {
      continue;
    }

    addConstraint(uniqueConstraintName(tableName, indexColumns as SqliteColumnMetadata[], 'key'), indexColumns as SqliteColumnMetadata[]);
  }

  return constraints;
}

export async function introspectSqliteSchema(
  db: LocalSQLiteDatabase,
  rawOptions: CreateSQLiteApolloClientOptions = {},
): Promise<SqliteSchemaMetadata> {
  const options = resolveOptions(rawOptions);
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
    const pkColumns = columns.filter((column) => column.pkOrder > 0).sort((left, right) => left.pkOrder - right.pkOrder);
    const uniqueConstraints =
      tableRow.type === 'table'
        ? await buildUniqueConstraints(db, tableRow.name, columns, indexes)
        : [];

    tables.push({
      columns,
      columnNames: new Set(columns.map((column) => column.name)),
      foreignKeys,
      indexes,
      kind: tableRow.type,
      name: tableRow.name,
      pkColumns,
      typeName: tableTypeName(tableRow.name, options),
      uniqueConstraints,
    });
  }

  return {
    tables,
    tablesByName: new Map(tables.map((table) => [table.name, table])),
  };
}

function clampLimit(value: number | null | undefined, options: ResolvedOptions) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return options.defaultLimit;
  }

  return Math.max(0, Math.min(options.maxLimit, Math.floor(value)));
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
  params: LocalSQLiteBindValue[],
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
  params: LocalSQLiteBindValue[],
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

async function selectTableRows(
  db: LocalSQLiteDatabase,
  table: SqliteTableMetadata,
  args: QueryArgs,
  options: ResolvedOptions,
) {
  const params: LocalSQLiteBindValue[] = [];
  const whereSql = buildWhereSql(table, args.where, params);
  const sql = [
    `SELECT * FROM ${quoteIdentifier(table.name)}`,
    whereSql ? ` WHERE ${whereSql}` : '',
    buildOrderBySql(table, args.order_by),
    ` LIMIT ${clampLimit(args.limit, options)}`,
    ` OFFSET ${clampOffset(args.offset)}`,
  ].join('');

  return db.getAllAsync(sql, ...params);
}

async function selectTableRowByPk(
  db: LocalSQLiteDatabase,
  table: SqliteTableMetadata,
  args: Record<string, unknown>,
) {
  const params: LocalSQLiteBindValue[] = [];
  const whereSql = table.pkColumns.map((column) => {
    params.push(toSqliteBindValue(args[column.name]));
    return `${quoteIdentifier(column.name)} = ?`;
  }).join(' AND ');

  return db.getFirstAsync(`SELECT * FROM ${quoteIdentifier(table.name)} WHERE ${whereSql} LIMIT 1`, ...params);
}

function columnValueEntries(table: SqliteTableMetadata, values: Record<string, unknown> | null | undefined) {
  if (!values) {
    return [];
  }

  return table.columns.flatMap((column): Array<[SqliteColumnMetadata, LocalSQLiteBindValue]> => {
    if (!Object.prototype.hasOwnProperty.call(values, column.name)) {
      return [];
    }

    return [[column, toSqliteBindValue(values[column.name])]];
  });
}

function affectedRowsFromRunResult(result: LocalSQLiteRunResult | void, fallback: number) {
  if (result && typeof result.changes === 'number' && Number.isFinite(result.changes)) {
    return Math.max(0, Math.floor(result.changes));
  }

  return fallback;
}

function lastInsertRowIdFromRunResult(result: LocalSQLiteRunResult | void) {
  if (result && typeof result.lastInsertRowId === 'number' && Number.isFinite(result.lastInsertRowId)) {
    return result.lastInsertRowId;
  }

  return null;
}

function objectHasAllPrimaryKeyValues(table: SqliteTableMetadata, values: Record<string, unknown>) {
  return (
    table.pkColumns.length > 0 &&
    table.pkColumns.every((column) => values[column.name] !== undefined && values[column.name] !== null)
  );
}

function isIntegerColumn(column: SqliteColumnMetadata) {
  return column.sqliteType.toUpperCase().includes('INT');
}

function uniqueConstraintForOnConflict(table: SqliteTableMetadata, onConflict: OnConflictArgs | null | undefined) {
  if (!onConflict) {
    return null;
  }

  const constraint = table.uniqueConstraints.find((candidate) => candidate.name === onConflict.constraint);
  if (!constraint) {
    throw new Error(`Unknown constraint ${onConflict.constraint} for ${table.name}`);
  }

  return constraint;
}

async function selectTableRowByColumns(
  db: LocalSQLiteDatabase,
  table: SqliteTableMetadata,
  columns: readonly SqliteColumnMetadata[],
  values: Record<string, unknown>,
) {
  if (columns.length === 0 || columns.some((column) => values[column.name] === undefined)) {
    return null;
  }

  const params: LocalSQLiteBindValue[] = [];
  const whereSql = columns
    .map((column) => {
      const value = values[column.name];
      if (value === null) {
        return `${quoteIdentifier(column.name)} IS NULL`;
      }

      params.push(toSqliteBindValue(value));
      return `${quoteIdentifier(column.name)} = ?`;
    })
    .join(' AND ');

  return db.getFirstAsync(`SELECT * FROM ${quoteIdentifier(table.name)} WHERE ${whereSql} LIMIT 1`, ...params);
}

async function selectInsertedRow(
  db: LocalSQLiteDatabase,
  table: SqliteTableMetadata,
  object: Record<string, unknown>,
  result: LocalSQLiteRunResult | void,
  onConflict: OnConflictArgs | null | undefined,
) {
  if (objectHasAllPrimaryKeyValues(table, object)) {
    const row = await selectTableRowByPk(db, table, object);
    if (row) {
      return row;
    }
  }

  const conflictConstraint = uniqueConstraintForOnConflict(table, onConflict);
  if (conflictConstraint) {
    const row = await selectTableRowByColumns(db, table, conflictConstraint.columns, object);
    if (row) {
      return row;
    }
  }

  const lastInsertRowId = lastInsertRowIdFromRunResult(result);
  if (lastInsertRowId === null) {
    return null;
  }

  if (table.pkColumns.length === 1 && isIntegerColumn(table.pkColumns[0]!)) {
    const row = await selectTableRowByPk(db, table, {
      [table.pkColumns[0]!.name]: lastInsertRowId,
    });
    if (row) {
      return row;
    }
  }

  return db
    .getFirstAsync(`SELECT * FROM ${quoteIdentifier(table.name)} WHERE rowid = ? LIMIT 1`, lastInsertRowId)
    .catch(() => null);
}

function buildOnConflictSql(
  table: SqliteTableMetadata,
  onConflict: OnConflictArgs | null | undefined,
  params: LocalSQLiteBindValue[],
) {
  const constraint = uniqueConstraintForOnConflict(table, onConflict);
  if (!constraint || !onConflict) {
    return '';
  }

  const conflictColumnsSql = constraint.columns.map((column) => quoteIdentifier(column.name)).join(', ');
  const updateColumns = onConflict.update_columns.filter((columnName) => table.columnNames.has(columnName));

  if (updateColumns.length === 0) {
    return ` ON CONFLICT (${conflictColumnsSql}) DO NOTHING`;
  }

  const assignments = updateColumns.map(
    (columnName) => `${quoteIdentifier(columnName)} = excluded.${quoteIdentifier(columnName)}`,
  );
  const whereSql = buildWhereSql(table, onConflict.where, params);

  return [
    ` ON CONFLICT (${conflictColumnsSql}) DO UPDATE SET ${assignments.join(', ')}`,
    whereSql ? ` WHERE ${whereSql}` : '',
  ].join('');
}

async function insertTableObject(
  db: LocalSQLiteDatabase,
  table: SqliteTableMetadata,
  object: Record<string, unknown>,
  onConflict?: OnConflictArgs | null,
) {
  const entries = columnValueEntries(table, object);
  const params = entries.map((entry) => entry[1]);
  const insertSql =
    entries.length > 0
      ? [
          `INSERT INTO ${quoteIdentifier(table.name)} (`,
          entries.map(([column]) => quoteIdentifier(column.name)).join(', '),
          `) VALUES (`,
          entries.map(() => '?').join(', '),
          `)`,
        ].join('')
      : `INSERT INTO ${quoteIdentifier(table.name)} DEFAULT VALUES`;
  const sql = `${insertSql}${buildOnConflictSql(table, onConflict, params)}`;

  const result = await db.runAsync(sql, ...params);
  const affectedRows = affectedRowsFromRunResult(result, 1);
  const row = affectedRows > 0 ? await selectInsertedRow(db, table, object, result, onConflict) : null;

  return {
    affectedRows,
    row,
  };
}

async function insertTableObjects(
  db: LocalSQLiteDatabase,
  table: SqliteTableMetadata,
  objects: Array<Record<string, unknown>>,
  onConflict?: OnConflictArgs | null,
): Promise<MutationResponse> {
  const returning: unknown[] = [];
  let affectedRows = 0;

  for (const object of objects) {
    const result = await insertTableObject(db, table, object, onConflict);
    affectedRows += result.affectedRows;

    if (result.row) {
      returning.push(result.row);
    }
  }

  return {
    affected_rows: affectedRows,
    returning,
  };
}

async function selectPrimaryKeyRowsForWhere(
  db: LocalSQLiteDatabase,
  table: SqliteTableMetadata,
  where: Record<string, unknown> | null | undefined,
) {
  if (table.pkColumns.length === 0) {
    return [];
  }

  const params: LocalSQLiteBindValue[] = [];
  const whereSql = buildWhereSql(table, where, params);
  const sql = [
    `SELECT ${table.pkColumns.map((column) => quoteIdentifier(column.name)).join(', ')}`,
    ` FROM ${quoteIdentifier(table.name)}`,
    whereSql ? ` WHERE ${whereSql}` : '',
  ].join('');

  return db.getAllAsync<Record<string, unknown>>(sql, ...params);
}

async function selectRowsByPrimaryKeyRows(
  db: LocalSQLiteDatabase,
  table: SqliteTableMetadata,
  primaryKeyRows: Array<Record<string, unknown>>,
) {
  const rows: unknown[] = [];

  for (const primaryKeyRow of primaryKeyRows) {
    const row = await selectTableRowByPk(db, table, primaryKeyRow);
    if (row) {
      rows.push(row);
    }
  }

  return rows;
}

function buildUpdateSql(
  table: SqliteTableMetadata,
  values: Record<string, unknown>,
  where: Record<string, unknown> | null | undefined,
  params: LocalSQLiteBindValue[],
) {
  const entries = columnValueEntries(table, values);
  if (entries.length === 0) {
    throw new Error(`No columns supplied for update_${table.name}`);
  }

  const assignments = entries.map(([column, value]) => {
    params.push(value);
    return `${quoteIdentifier(column.name)} = ?`;
  });
  const whereParams: LocalSQLiteBindValue[] = [];
  const whereSql = buildWhereSql(table, where, whereParams);
  params.push(...whereParams);

  return [
    `UPDATE ${quoteIdentifier(table.name)} SET ${assignments.join(', ')}`,
    whereSql ? ` WHERE ${whereSql}` : '',
  ].join('');
}

function buildPrimaryKeyWhereSql(
  table: SqliteTableMetadata,
  values: Record<string, unknown>,
  params: LocalSQLiteBindValue[],
) {
  return table.pkColumns
    .map((column) => {
      params.push(toSqliteBindValue(values[column.name]));
      return `${quoteIdentifier(column.name)} = ?`;
    })
    .join(' AND ');
}

function buildUpdateByPkSql(
  table: SqliteTableMetadata,
  values: Record<string, unknown>,
  primaryKeyValues: Record<string, unknown>,
  params: LocalSQLiteBindValue[],
) {
  const entries = columnValueEntries(table, values);
  if (entries.length === 0) {
    throw new Error(`No columns supplied for update_${table.name}_by_pk`);
  }

  const assignments = entries.map(([column, value]) => {
    params.push(value);
    return `${quoteIdentifier(column.name)} = ?`;
  });
  const whereSql = buildPrimaryKeyWhereSql(table, primaryKeyValues, params);

  return `UPDATE ${quoteIdentifier(table.name)} SET ${assignments.join(', ')} WHERE ${whereSql}`;
}

async function updateTableRows(
  db: LocalSQLiteDatabase,
  table: SqliteTableMetadata,
  args: UpdateArgs,
): Promise<MutationResponse> {
  const primaryKeyRows = await selectPrimaryKeyRowsForWhere(db, table, args.where);
  const params: LocalSQLiteBindValue[] = [];
  const result = await db.runAsync(buildUpdateSql(table, args._set, args.where, params), ...params);
  const returning = await selectRowsByPrimaryKeyRows(db, table, primaryKeyRows);

  return {
    affected_rows: affectedRowsFromRunResult(result, returning.length),
    returning,
  };
}

async function updateTableRowByPk(
  db: LocalSQLiteDatabase,
  table: SqliteTableMetadata,
  args: UpdateByPkArgs,
) {
  const params: LocalSQLiteBindValue[] = [];
  const result = await db.runAsync(buildUpdateByPkSql(table, args._set, args.pk_columns, params), ...params);
  const affectedRows = affectedRowsFromRunResult(result, 0);

  if (affectedRows === 0) {
    return null;
  }

  const nextPkColumns = { ...args.pk_columns };
  for (const column of table.pkColumns) {
    if (Object.prototype.hasOwnProperty.call(args._set, column.name)) {
      nextPkColumns[column.name] = args._set[column.name];
    }
  }

  return selectTableRowByPk(db, table, nextPkColumns);
}

export function buildSQLiteGraphQLSchema(
  db: LocalSQLiteDatabase,
  metadata: SqliteSchemaMetadata,
  rawOptions: CreateSQLiteApolloClientOptions = {},
) {
  const options = resolveOptions(rawOptions);
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
  const insertInputTypes = new Map<string, GraphQLInputObjectType>();
  const setInputTypes = new Map<string, GraphQLInputObjectType>();
  const primaryKeyInputTypes = new Map<string, GraphQLInputObjectType>();
  const mutationResponseTypes = new Map<string, GraphQLObjectType>();
  const constraintTypes = new Map<string, GraphQLEnumType>();
  const updateColumnTypes = new Map<string, GraphQLEnumType>();
  const onConflictTypes = new Map<string, GraphQLInputObjectType>();

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

  const insertInputType = (table: SqliteTableMetadata): GraphQLInputObjectType => {
    const existing = insertInputTypes.get(table.name);
    if (existing) {
      return existing;
    }

    const type = new GraphQLInputObjectType({
      name: `${table.typeName}_insert_input`,
      fields: Object.fromEntries(
        table.columns.map((column) => [column.name, { type: column.graphQLType as GraphQLInputType }]),
      ),
    });

    insertInputTypes.set(table.name, type);
    return type;
  };

  const setInputType = (table: SqliteTableMetadata): GraphQLInputObjectType => {
    const existing = setInputTypes.get(table.name);
    if (existing) {
      return existing;
    }

    const type = new GraphQLInputObjectType({
      name: `${table.typeName}_set_input`,
      fields: Object.fromEntries(
        table.columns.map((column) => [column.name, { type: column.graphQLType as GraphQLInputType }]),
      ),
    });

    setInputTypes.set(table.name, type);
    return type;
  };

  const primaryKeyInputType = (table: SqliteTableMetadata): GraphQLInputObjectType => {
    const existing = primaryKeyInputTypes.get(table.name);
    if (existing) {
      return existing;
    }

    const type = new GraphQLInputObjectType({
      name: `${table.typeName}_pk_columns_input`,
      fields: Object.fromEntries(
        table.pkColumns.map((column) => [column.name, { type: new GraphQLNonNull(column.graphQLType) }]),
      ),
    });

    primaryKeyInputTypes.set(table.name, type);
    return type;
  };

  const mutationResponseType = (table: SqliteTableMetadata): GraphQLObjectType => {
    const existing = mutationResponseTypes.get(table.name);
    if (existing) {
      return existing;
    }

    const type = new GraphQLObjectType({
      name: `${table.typeName}_mutation_response`,
      fields: {
        affected_rows: { type: new GraphQLNonNull(GraphQLInt) },
        returning: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType(table)))),
        },
      },
    });

    mutationResponseTypes.set(table.name, type);
    return type;
  };

  const constraintEnumType = (table: SqliteTableMetadata): GraphQLEnumType | null => {
    if (table.uniqueConstraints.length === 0) {
      return null;
    }

    const existing = constraintTypes.get(table.name);
    if (existing) {
      return existing;
    }

    const type = new GraphQLEnumType({
      name: `${table.typeName}_constraint`,
      values: Object.fromEntries(
        table.uniqueConstraints.map((constraint) => [constraint.name, { value: constraint.name }]),
      ),
    });

    constraintTypes.set(table.name, type);
    return type;
  };

  const updateColumnEnumType = (table: SqliteTableMetadata): GraphQLEnumType => {
    const existing = updateColumnTypes.get(table.name);
    if (existing) {
      return existing;
    }

    const type = new GraphQLEnumType({
      name: `${table.typeName}_update_column`,
      values: Object.fromEntries(table.columns.map((column) => [column.name, { value: column.name }])),
    });

    updateColumnTypes.set(table.name, type);
    return type;
  };

  const onConflictInputType = (table: SqliteTableMetadata): GraphQLInputObjectType | null => {
    const constraintType = constraintEnumType(table);
    if (!constraintType) {
      return null;
    }

    const existing = onConflictTypes.get(table.name);
    if (existing) {
      return existing;
    }

    const updateColumnType = updateColumnEnumType(table);
    const type = new GraphQLInputObjectType({
      name: `${table.typeName}_on_conflict`,
      fields: {
        constraint: { type: new GraphQLNonNull(constraintType) },
        update_columns: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(updateColumnType))) },
        where: { type: whereInputType(table) },
      },
    });

    onConflictTypes.set(table.name, type);
    return type;
  };

  const queryFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  const mutationFields: GraphQLFieldConfigMap<unknown, unknown> = {};

  for (const table of metadata.tables) {
    queryFields[table.name] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType(table)))),
      args: {
        where: { type: whereInputType(table) },
        order_by: { type: new GraphQLList(new GraphQLNonNull(orderInputType(table))) },
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
      },
      resolve: (_source, args) => selectTableRows(db, table, args as QueryArgs, options),
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

    if (table.kind !== 'table') {
      continue;
    }

    mutationFields[`insert_${table.name}`] = {
      type: new GraphQLNonNull(mutationResponseType(table)),
      args: {
        objects: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(insertInputType(table)))),
        },
        ...(onConflictInputType(table) ? { on_conflict: { type: onConflictInputType(table)! } } : {}),
      },
      resolve: (_source, args) => {
        const insertArgs = args as InsertManyArgs;
        return insertTableObjects(db, table, insertArgs.objects, insertArgs.on_conflict);
      },
    };

    mutationFields[`insert_${table.name}_one`] = {
      type: objectType(table),
      args: {
        object: { type: new GraphQLNonNull(insertInputType(table)) },
        ...(onConflictInputType(table) ? { on_conflict: { type: onConflictInputType(table)! } } : {}),
      },
      resolve: async (_source, args) => {
        const insertArgs = args as InsertOneArgs;
        const response = await insertTableObjects(db, table, [insertArgs.object], insertArgs.on_conflict);
        return response.returning[0] ?? null;
      },
    };

    mutationFields[`update_${table.name}`] = {
      type: new GraphQLNonNull(mutationResponseType(table)),
      args: {
        where: { type: new GraphQLNonNull(whereInputType(table)) },
        _set: { type: new GraphQLNonNull(setInputType(table)) },
      },
      resolve: (_source, args) => updateTableRows(db, table, args as UpdateArgs),
    };

    if (table.pkColumns.length > 0) {
      mutationFields[`update_${table.name}_by_pk`] = {
        type: objectType(table),
        args: {
          pk_columns: { type: new GraphQLNonNull(primaryKeyInputType(table)) },
          _set: { type: new GraphQLNonNull(setInputType(table)) },
        },
        resolve: (_source, args) => updateTableRowByPk(db, table, args as UpdateByPkArgs),
      };
    }
  }

  const mutation = Object.keys(mutationFields).length
    ? new GraphQLObjectType({
        name: 'Mutation',
        fields: mutationFields,
      })
    : undefined;

  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: queryFields,
    }),
    mutation,
  });
}

export function createSQLiteGraphQLLink(schema: GraphQLSchema) {
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

export function buildSQLiteTypePolicies(metadata: SqliteSchemaMetadata): TypePolicies {
  const policies: TypePolicies = {};

  for (const table of metadata.tables) {
    policies[table.typeName] = {
      keyFields: table.pkColumns.length === 1 ? [table.pkColumns[0]!.name] : false,
    };
  }

  return policies;
}

export async function createSQLiteApolloClient(
  db: LocalSQLiteDatabase,
  options: CreateSQLiteApolloClientOptions = {},
): Promise<ApolloClient> {
  const metadata = await introspectSqliteSchema(db, options);
  const schema = buildSQLiteGraphQLSchema(db, metadata, options);

  return new ApolloClient({
    cache: new InMemoryCache({
      typePolicies: buildSQLiteTypePolicies(metadata),
    }),
    link: createSQLiteGraphQLLink(schema),
  });
}

export function getSQLiteApolloClient(
  db: LocalSQLiteDatabase,
  options?: CreateSQLiteApolloClientOptions,
): Promise<ApolloClient> {
  if (options) {
    return createSQLiteApolloClient(db, options);
  }

  const existing = sqliteApolloClients.get(db);
  if (existing) {
    return existing;
  }

  const next = createSQLiteApolloClient(db);
  sqliteApolloClients.set(db, next);
  return next;
}
