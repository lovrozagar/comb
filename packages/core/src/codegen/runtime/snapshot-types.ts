/**
 * What the runtime reader writes for the parent: every table the tables module exports, as drizzle
 * built it and as comb's `c` helpers recorded it, in plain JSON. No drizzle object crosses.
 */

/**
 * Where a value lives: the module that exports it, a project file's path or a package's specifier
 * as a project file wrote it, and the name it is exported under
 */
type ModuleExport = { external: boolean; module: string; name: string }

/** What a `c` helper recorded, its values read and its objects located by the export that holds them */
type SnapshotComb = {
	constraints: Record<string, boolean | number | string>
	kind: string
	prefix: string | null
	/** where the exact zod schema a c.json column was given is exported; null when nowhere */
	schema: ModuleExport | null
	states: { initial: string | null; terminal: string[] | null; transitions: Record<string, string[]> | null } | null
	values: string[] | null
}

type SnapshotForeignKey = {
	/** the referenced column's property key */
	column: string
	onDelete: string | null
	onUpdate: string | null
	/** the referenced table's export name in the tables module */
	table: string
	/** a composite key's columns, each paired by position with the referenced one; null for a one-column key */
	key?: { columns: string[]; refColumns: string[] } | null
}

type SnapshotColumn = {
	/** SQLite's AUTOINCREMENT on an integer key */
	autoIncrement: boolean
	comb: SnapshotComb | null
	/** drizzle's column class, `SQLiteText` or `PgVarchar` */
	columnType: string
	/** drizzle's data type, `string` or `number int53` */
	dataType: string
	enumValues: string[] | null
	foreignKey: SnapshotForeignKey | null
	/** generated always as an expression, stored or virtual */
	generated: boolean
	/** a default value, a default SQL expression or a default function */
	hasDefault: boolean
	/** an identity column, always or by default */
	identity: boolean
	/** the property key */
	key: string
	/** a Postgres array's declared dimensions, 0 for a column of one value */
	dimensions: number
	length: number | null
	notNull: boolean
	onUpdate: boolean
	primary: boolean
	sqlName: string
	/** the column's SQL type, as DDL writes it */
	sqlType: string
	/** the name `.unique()` gave it, or drizzle's for it; null when it is not unique */
	unique: string | null
}

type SnapshotIndex = {
	/** the property keys of plain column keys; null when a key is an expression */
	columns: string[] | null
	/** the keys as SQL, unqualified */
	expression: string
	name: string
	unique: boolean
	where: string | null
}

type SnapshotTable = {
	checks: Array<{ expression: string; name: string }>
	columns: SnapshotColumn[]
	/** a composite primary key's property keys, empty for none */
	compositeKey: string[]
	dialect: "postgres" | "sqlite"
	exportName: string
	indexes: SnapshotIndex[]
	/** the Postgres schema a pgSchema's table is in; null for the default */
	schema: string | null
	sqlName: string
	uniques: Array<{ columns: string[]; name: string }>
}

type Snapshot = { tables: SnapshotTable[] }

export type { ModuleExport, Snapshot, SnapshotColumn, SnapshotComb, SnapshotForeignKey, SnapshotIndex, SnapshotTable }
