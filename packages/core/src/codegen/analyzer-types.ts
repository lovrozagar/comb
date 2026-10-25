import type { CombColumnKind } from "../meta/column.ts"
/**
 * TableMeta — serializable intermediate format produced by TableAnalyzer.
 * No ts-morph or Drizzle dependencies. All generators consume this.
 */

/** Constraint annotations parsed from field type arguments */
type FieldConstraintsMeta = {
	autogenerate: boolean
	email: boolean
	/** an https URL or a data:image/ URI */
	imageUri: boolean
	lowercase: boolean
	max: number | null
	maxBytes: number | null
	min: number | null
	/** a name: letters, marks, numbers, spaces and punctuation */
	name: boolean
	/** a reference that moves on update; every other reference is set once (F25) */
	mutable: boolean
	nomutate: boolean
	password: boolean
	pattern: string | null
	private: boolean
	tenant: boolean
	trim: boolean
	uppercase: boolean
	url: boolean
}

/** State machine declared on an enum column */
type StateMachineMeta = {
	initial: string | null
	terminal: string[] | null
	transitions: Record<string, string[]> | null
}

/** A name a generated file must import, with the module the tables file gets it from. */
type ImportRef = {
	/** the module specifier as the tables file writes it */
	from: string
	/** the exported name (`*` for a namespace import, `default` for a default import) */
	imported: string
	/** the local name the tables file uses */
	name: string
	/** the module's file when it is in the project; null for a package */
	path: string | null
}

/** Foreign key reference from this field to another table */
type ForeignKeyRef = {
	column: string
	onDelete?: string | undefined
	onUpdate?: string | undefined
	refColumn: string
	refTable: string
	/** whether the referenced column is a c.id key, whose id rules the reference takes (F10) */
	toId?: boolean | undefined
	/** a composite key's columns, each paired by position with the referenced one (F46) */
	key?: { columns: string[]; refColumns: string[] } | undefined
}

/** A single column/field in a table, as drizzle built it and its `c` helper recorded it */
type FieldMeta = {
	/** SQLite's AUTOINCREMENT on an integer key */
	autoIncrement: boolean
	/** drizzle's column class: `SQLiteText`, `PgVarchar` */
	columnType: string
	/** the `c` helper that built the column; null for a plain drizzle column */
	combKind: CombColumnKind | null
	constraints: FieldConstraintsMeta
	/** drizzle's data type: `string`, `number int53`, `object json` */
	dataType: string
	/** the `c` helper's name, else drizzle's column class */
	drizzleHelper: string
	/** the values of a c.enum, a pgEnum or an enum text column; null for any other */
	enumValues: string[] | null
	/** State machine declared as c.enum's third argument, null when absent */
	states: StateMachineMeta | null
	/** FK reference if .references(() => table.column) */
	foreignKey: ForeignKeyRef | null
	/** generated always as an expression: the database writes it */
	generated: boolean
	/** a default value, default SQL or default function fills it when a write leaves it out */
	hasDefault: boolean
	/** an identity column, always or by default */
	identity: boolean
	/** a column of the table's composite primary key */
	inCompositeKey: boolean
	/** NOT NULL */
	isNotNull: boolean
	/** the table's single-column primary key */
	isPrimaryKey: boolean
	/** the name the generated DTO imports a c.json column's schema under, null for any other column */
	jsonSchemaName: string | null
	/** the names the field's generated schema uses and must import (a c.json schema) */
	schemaImports: ImportRef[]
	/** the declared length: c.text's max, or drizzle's `length` */
	length: number | null
	/** Field name as defined in the table schema object */
	name: string
	/** c.id's prefix; null for any other column */
	prefix: string | null
	/** an update hook fills it on every update */
	onUpdate: boolean
	/** The column's SQL name: what the engine reports in errors and what DDL and triggers name */
	sqlName: string
	/** the column's SQL type, as DDL writes it */
	sqlType: string
	/** the name of the column's own `.unique()`, drizzle's when it gives none; null when it has none */
	unique: string | null
}

/** Unique index from table options (3rd arg arrow function) */
type UniqueIndexMeta = {
	columns: string[]
	name: string
}

/** A unique index whose keys are not all plain columns, keyed in the constraint map by its name */
type ExpressionIndexMeta = {
	/** its keys as SQL */
	expression: string
	name: string
}

/** Check constraint from table options */
type CheckConstraintMeta = {
	expression: string
	name: string
}

/** Timestamp tracking for a table */
type TimestampsMeta = {
	createdAt: boolean
	deletedAt: boolean
	/** each timestamp column's property name as the table declares it; null when it has none */
	names: { createdAt: string | null; deletedAt: string | null; updatedAt: string | null }
	/** the casing every timestamp shares; mixed when they differ, which no shared spread fits */
	style: "camelCase" | "mixed" | "snake_case"
	updatedAt: boolean
}

/** Complete metadata for a single table */
type TableMeta = {
	/** Check constraints from table options */
	checkConstraints: CheckConstraintMeta[]
	/** All fields in the table */
	fields: FieldMeta[]
	/** unique indexes on an expression */
	expressionIndexes: ExpressionIndexMeta[]
	/** Whether composite PK exists in table options */
	hasCompositePrimaryKey: boolean
	/** Entity ID prefix from c.id("prefix"), null if c.serialId() or missing */
	idPrefix: string | null
	/** the Postgres schema of a pgSchema's table; null for the default */
	schema: string | null
	/** SQL table name (first arg to createTable) */
	sqlName: string
	/** Detected timestamp fields and style */
	timestamps: TimestampsMeta
	/** Partial (`.where()`) unique indexes on plain columns: mapped as constraints, never published as uniqueness */
	partialUniqueIndexes: UniqueIndexMeta[]
	/** Unique indexes from table options */
	uniqueIndexes: UniqueIndexMeta[]
	/** Variable name (export const X = createTable...) */
	varName: string
}

/** Imports discovered during analysis */
type ImportsMeta = {
	/** Enum constant name -> module path */
	enumImports: Map<string, string>
	/** All imported identifiers -> module path */
	identifiers: Map<string, string>
	/** JSON schema names referenced by c.json() */
	jsonSchemaImports: Set<string>
}

/** What a constraint can hold */
type ConstantValue = boolean | number | string

/** Full analysis result */
type AnalysisResult = {
	/** Database name derived from tables file path */
	dbName: string
	/** The engine the tables are built for, by the drizzle builder each one's file imports; null when none says */
	dialect: "postgres" | "sqlite" | null
	imports: ImportsMeta
	tables: TableMeta[]
	/** Relative import path for the tables file */
	tablesImportPath: string
}

export type {
	ConstantValue,
	ExpressionIndexMeta,
	ImportRef,
	AnalysisResult,
	CheckConstraintMeta,
	FieldConstraintsMeta,
	FieldMeta,
	ForeignKeyRef,
	ImportsMeta,
	StateMachineMeta,
	TableMeta,
	TimestampsMeta,
	UniqueIndexMeta,
}
