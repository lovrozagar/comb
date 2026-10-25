/**
 * The runtime reader: load the tables module, find every drizzle table it exports, and read each
 * as drizzle built it (getTableConfig) and as comb's `c` helpers recorded it (combColumnMeta).
 * Objects a generated file must import, a c.json schema or a c.enum values array, are located by
 * identity among the exports of the project modules the tables module loads.
 */
import { Column, getTableColumns, getTableName, is, type SQL, type Table } from "drizzle-orm"
import { ExtraConfigColumn, getTableConfig as pgConfig, IndexedColumn, PgDialect, PgTable } from "drizzle-orm/pg-core"
import { getTableConfig as sqliteConfig, SQLiteDialect, SQLiteTable } from "drizzle-orm/sqlite-core"
import { pgObjectName } from "../../identifier.ts"
import { combColumnMeta } from "../../meta/column.ts"
import { constraintsOf, statesOf, STRING_LIST } from "./read-comb.ts"
import type {
	ModuleExport,
	Snapshot,
	SnapshotColumn,
	SnapshotComb,
	SnapshotIndex,
	SnapshotTable,
} from "./snapshot-types.ts"

type Namespace = Record<string, unknown>
type Loaded = { external: boolean; module: string; namespace: Namespace }

/** The exports holding `value`, ordered: a module other than the tables file first, then the shorter path, then by name */
function exportsHolding(value: unknown, loaded: readonly Loaded[], tablesPath: string): ModuleExport[] {
	const found = loaded.flatMap(({ external, module, namespace }) =>
		Object.entries(namespace)
			.filter(([, held]) => held === value)
			.map(([name]) => ({ external, module, name })),
	)
	const rank = (at: ModuleExport) => (at.module === tablesPath ? 1 : 0)
	return found.sort(
		(a, b) =>
			rank(a) - rank(b) ||
			a.module.length - b.module.length ||
			a.module.localeCompare(b.module) ||
			a.name.localeCompare(b.name),
	)
}

/** What the whole read shares: the loaded modules, the tables file, and each table it exports by its name */
type Context = {
	loaded: readonly Loaded[]
	tables: ReadonlyMap<Table, string>
	tablesPath: string
	/** the packages that would not load on their own, which no schema can be found in */
	unloaded: readonly string[]
}

function combOf(column: Column, at: string, context: Context): SnapshotComb | null {
	const meta = combColumnMeta(column)
	if (meta === undefined) return null
	const located = (value: unknown) =>
		value === undefined ? null : (exportsHolding(value, context.loaded, context.tablesPath)[0] ?? null)
	if (meta.values !== undefined && !STRING_LIST(meta.values)) throw new Error(`${at}: c.enum takes an array of strings`)
	const schema = located(meta.schema)
	if (meta.kind === "json" && schema === null) {
		const skipped = context.unloaded.length === 0 ? "" : ` (${context.unloaded.join(", ")} would not load on their own)`
		throw new Error(
			`${at}: no module of the project exports the schema its c.json is given${skipped}; export it, so the generated DTOs can import it`,
		)
	}
	return {
		constraints: constraintsOf(meta.constraints, at),
		kind: meta.kind,
		prefix: meta.prefix ?? null,
		schema,
		states: statesOf(meta.states, at),
		values: meta.values === undefined ? null : [...meta.values],
	}
}

type ReadColumn = Column & {
	autoIncrement?: boolean
	defaultFn?: unknown
	generated?: unknown
	generatedIdentity?: unknown
	isUnique?: boolean
	length?: number
	onUpdateFn?: unknown
	table: Table
	uniqueName?: string
}

/**
 * The name an unnamed `.unique()` has in the database: drizzle-kit writes it named on SQLite, and as
 * a bare UNIQUE on Postgres, which Postgres names `<table>_<column>_key` (F31)
 */
const unnamedUnique = (column: ReadColumn): string =>
	is(column.table, PgTable)
		? pgObjectName(getTableName(column.table), column.name, "key")
		: `${getTableName(column.table)}_${column.name}_unique`

/**
 * Whether a write that leaves the column out still fills it: a default, a default or update
 * function, an identity, or a Postgres serial. Not drizzle's own hasDefault, which an SQLite
 * integer key has for its rowid, a value the engine fills only when none is given
 */
const filledByDefault = (column: ReadColumn) =>
	column.default !== undefined ||
	column.defaultFn !== undefined ||
	column.onUpdateFn !== undefined ||
	column.generatedIdentity !== undefined ||
	/^Pg(?:Big|Small)?Serial/.test(column.columnType)

function columnOf([key, column]: [string, ReadColumn], at: string, context: Context): SnapshotColumn {
	return {
		autoIncrement: column.autoIncrement === true,
		comb: combOf(column, at, context),
		columnType: column.columnType,
		dataType: column.dataType,
		enumValues: column.enumValues === undefined ? null : [...column.enumValues],
		foreignKey: null,
		generated: column.generated !== undefined,
		hasDefault: filledByDefault(column),
		identity: column.generatedIdentity !== undefined,
		key,
		length: typeof column.length === "number" ? column.length : null,
		notNull: column.notNull,
		onUpdate: column.onUpdateFn !== undefined,
		primary: column.primary,
		sqlName: column.name,
		sqlType: column.getSQLType(),
		unique: column.isUnique === true ? (column.uniqueName ?? unnamedUnique(column)) : null,
	}
}

type Config = ReturnType<typeof sqliteConfig> & { schema?: string | undefined }

type Dialect = {
	config: (table: Table) => Config
	name: "postgres" | "sqlite"
	render: (chunk: SQL) => string
}

function dialectOf(table: Table): Dialect {
	const sqlite = is(table, SQLiteTable)
	const dialect = sqlite ? new SQLiteDialect() : new PgDialect()
	/* "indexes" renders a column by its own name, as DDL and the constraint map name it */
	const render = (chunk: SQL) => (dialect as SQLiteDialect).sqlToQuery(chunk.inlineParams(), "indexes").sql
	return {
		config: (sqlite ? sqliteConfig : pgConfig) as unknown as (table: Table) => Config,
		name: sqlite ? "sqlite" : "postgres",
		render,
	}
}

type IndexConfig = { columns: unknown[]; name: string; unique: boolean; where?: SQL | undefined }

function indexOf(config: IndexConfig, keyOf: (column: unknown) => string | undefined, dialect: Dialect): SnapshotIndex {
	const keys = config.columns.map(keyOf)
	const expression = config.columns
		.map((part) => (keyOf(part) === undefined ? dialect.render(part as SQL) : `"${(part as Column).name}"`))
		.join(", ")
	return {
		columns: keys.every((key) => key !== undefined) ? (keys as string[]) : null,
		expression,
		name: config.name,
		unique: config.unique,
		where: config.where === undefined ? null : dialect.render(config.where),
	}
}

/** What a foreign key references; an error naming its table when its callback cannot be followed */
function referenceOf(fk: Config["foreignKeys"][number], table: string): ReturnType<typeof fk.reference> {
	try {
		return fk.reference()
	} catch (error) {
		throw new Error(`${table}: a foreign key's target cannot be read: ${(error as Error).message}`, { cause: error })
	}
}

/** The table's export name in the tables module, or an error naming the column that references it */
function targetName(target: Table, at: string, context: Context): string {
	const name = context.tables.get(target)
	if (name !== undefined) return name
	const sqlName = getTableConfig(target).name
	const elsewhere = exportsHolding(target, context.loaded, context.tablesPath)[0]
	throw new Error(
		elsewhere === undefined
			? `${at} references the table ${sqlName}, which no module of the project exports`
			: `${at} references the table ${sqlName} (${elsewhere.name} in ${elsewhere.module}), which the tables file does not export; export it there`,
	)
}

function getTableConfig(table: Table): Config {
	return dialectOf(table).config(table)
}

function tableOf([table, exportName]: [Table, string], context: Context): SnapshotTable {
	const dialect = dialectOf(table)
	const config = dialect.config(table)
	const entries = Object.entries(getTableColumns(table)) as Array<[string, ReadColumn]>
	/*
	 * A column a third argument names, by its key: sqlite-core passes the table's own column, pg-core
	 * a stand-in (an ExtraConfigColumn, or an index's IndexedColumn) matched by its SQL name (F45).
	 * SQL is no column (undefined); any other column, one of another table, is refused naming this one.
	 */
	const keyOf = (column: unknown): string | undefined => {
		const own = entries.find(([, each]) => each === column)?.[0]
		if (own !== undefined || !(is(column, Column) || is(column, IndexedColumn))) return own
		const standIn = is(column, ExtraConfigColumn) || is(column, IndexedColumn)
		const named = standIn ? entries.find(([, each]) => each.name === column.name)?.[0] : undefined
		if (named !== undefined) return named
		throw new Error(
			`${exportName}: its third argument names the column ${column.name}, which is no column of ${config.name}`,
		)
	}
	const columns = entries.map((entry) => columnOf(entry, `${exportName}.${entry[0]}`, context))
	for (const fk of config.foreignKeys) {
		const reference = referenceOf(fk, exportName)
		const target = reference.foreignTable as Table
		const targetColumns = Object.entries(getTableColumns(target))
		const own = reference.columns.map((column) => keyOf(column) as string)
		const refs = reference.foreignColumns.map(
			(column) => targetColumns.find(([, each]) => each === column)?.[0] as string,
		)
		/* every column of the key references its own target column, the key whole beside it (F46) */
		const key = own.length > 1 ? { columns: own, refColumns: refs } : null
		const targetExport = targetName(target, `${exportName}.${own[0]}`, context)
		for (const [i, name] of own.entries()) {
			;(columns.find((column) => column.key === name) as SnapshotColumn).foreignKey = {
				column: refs[i] as string,
				key,
				onDelete: fk.onDelete ?? null,
				onUpdate: fk.onUpdate ?? null,
				table: targetExport,
			}
		}
	}
	return {
		checks: config.checks.map((check) => ({ expression: dialect.render(check.value), name: check.name })),
		columns,
		compositeKey: config.primaryKeys.flatMap((key) => key.columns.map((column) => keyOf(column) as string)),
		dialect: dialect.name,
		exportName,
		indexes: config.indexes.map((index) => indexOf(index.config as IndexConfig, keyOf, dialect)),
		schema: config.schema ?? null,
		sqlName: config.name,
		uniques: config.uniqueConstraints.map((unique) => ({
			columns: unique.columns.map((column) => keyOf(column) as string),
			name: unique.name as string,
		})),
	}
}

/**
 * The snapshot of every table the first loaded module exports. A table exported under two names
 * is read once, under the first by name.
 */
function snapshotOf(loaded: readonly Loaded[], unloaded: readonly string[] = []): Snapshot {
	const first = loaded[0] as Loaded
	const tables = new Map<Table, string>()
	for (const name of Object.keys(first.namespace).sort()) {
		const value = first.namespace[name]
		if (isTable(value) && !tables.has(value)) tables.set(value, name)
		/* drizzle assigns each column onto its table, so one named __proto__ replaces the table's
		 * prototype: what is left keeps drizzle's table name but is no table (F36) */
		else if (!isTable(value) && hasTableName(value))
			throw new Error(
				`${name}: a column named __proto__ replaced this table's prototype, so drizzle cannot use it; rename the column`,
			)
	}
	const context: Context = { loaded, tables, tablesPath: first.module, unloaded }
	return { tables: [...tables].map((entry) => tableOf(entry, context)) }
}

/** Whether `value` carries drizzle's table name, as every table drizzle builds does */
const hasTableName = (value: unknown): boolean =>
	typeof value === "object" && value !== null && Object.hasOwn(value, Symbol.for("drizzle:Name"))

const isTable = (value: unknown): value is Table => is(value, SQLiteTable) || is(value, PgTable)

export { exportsHolding, snapshotOf, type Loaded, type Namespace }
