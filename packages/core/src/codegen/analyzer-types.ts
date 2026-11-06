import type { CombColumnKind } from "../meta/column.ts"
/**
 * TableMeta — serializable intermediate format produced by TableAnalyzer.
 * No ts-morph or Drizzle dependencies. All generators consume this.
 */

/** Constraint annotations parsed from field type arguments */
type FieldConstraintsMeta = {
	/** comb or the database fills the column, so the generated create and update DTOs leave it out; on by default for a `c.createdAt`, `c.updatedAt` or `c.deletedAt` column, and for any `createdAt`, `updatedAt` or `deletedAt` column a default or update hook fills */
	autogenerate: boolean
	/** the generated DTOs take only an email address */
	email: boolean
	/** an https URL or a data:image/ URI */
	imageUri: boolean
	/** the generated DTOs lowercase the text before they check it */
	lowercase: boolean
	/** the largest value the generated DTOs take: a text column's length in characters, a timestamp's epoch milliseconds, any other column's value; null when unbounded */
	max: number | null
	/** the most bytes a c.json value may take once stringified; null when unbounded */
	maxBytes: number | null
	/** the smallest value the generated DTOs take, measured as `max` is; null when unbounded */
	min: number | null
	/** a name: letters, marks, numbers, spaces and punctuation */
	name: boolean
	/** a foreign key the generated update DTO takes, so a row can move to another parent; every other reference is set once, at creation */
	mutable: boolean
	/** set at creation and never changed: the generated update DTO leaves it out */
	nomutate: boolean
	/** a stored password hash: kept as written, with no transform, and held only to a plain text's rules: its bounds, at least 1 character when NOT NULL, its pattern and the text guard */
	password: boolean
	/** the regex the generated DTOs hold the text to, as a `/source/flags` literal with the `u` flag; null when none */
	pattern: string | null
	/** never read back: the generated read DTOs and the meta stamp leave it out and the manifest flags it `private: true`; also set for a field whose name starts with `_` */
	private: boolean
	/** the name the generated relation of this foreign key takes, where the column's role would collide with another; null or absent for the role's own name */
	relation?: string | null | undefined
	/** the column that scopes the table's rows to a tenant, set once at creation; declared, never inferred, and at most one per table */
	tenant: boolean
	/** the generated DTOs trim surrounding whitespace before they check the text */
	trim: boolean
	/** the generated DTOs uppercase the text before they check it */
	uppercase: boolean
	/** the generated create and update DTOs take only an https URL of 9 characters or more, trimmed and stripped of tabs and newlines first; a read takes what the column holds */
	url: boolean
}

/** State machine declared on an enum column */
type StateMachineMeta = {
	/** the state a new row starts in; null when the declaration names none */
	initial: string | null
	/** the states a row never leaves; null when the declaration names none */
	terminal: string[] | null
	/** each state, to the states a row may move to from it; null when the declaration names none */
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
	/** the referencing column's property name in its table */
	column: string
	/** the action the database takes on this row when the referenced row is deleted, as drizzle declares it (`cascade`, `set null`); absent for the database's default */
	onDelete?: string | undefined
	/** the action the database takes on this row when the referenced key changes, as drizzle declares it; absent for the database's default */
	onUpdate?: string | undefined
	/** the referenced column's property name in its table */
	refColumn: string
	/** the referenced table's export name in the tables file */
	refTable: string
	/** whether the referenced column is a c.id key, so the reference takes the id rule, 1 to 48 characters and no blank; its prefix is not checked */
	toId?: boolean | undefined
	/** a composite foreign key's columns; absent for a single-column key */
	key?:
		| {
				/** the referencing property names, in key order */
				columns: string[]
				/** the referenced property names, each paired by position with `columns` */
				refColumns: string[]
		  }
		| undefined
}

/** A single column/field in a table, as drizzle built it and its `c` helper recorded it */
type FieldMeta = {
	/** SQLite's AUTOINCREMENT on an integer key */
	autoIncrement: boolean
	/** drizzle's column class: `SQLiteText`, `PgVarchar` */
	columnType: string
	/** the `c` helper that built the column; null for a plain drizzle column */
	combKind: CombColumnKind | null
	/** the constraints the `c` helper declared, with comb's defaults applied; for a plain drizzle column, every flag off but `private` on a name starting with `_` and `autogenerate` on a filled timestamp key */
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
	/** an interval's declared precision, which `sqlType` leaves out at 0 as drizzle writes it; null or absent for none or another type */
	intervalPrecision?: number | null | undefined
	/** the column is NOT NULL: a write must give it a value or leave it to a default */
	isNotNull: boolean
	/** the table's single-column primary key */
	isPrimaryKey: boolean
	/** the name the generated DTO imports a c.json column's schema under, null for any other column */
	jsonSchemaName: string | null
	/** the names the field's generated schema uses and must import (a c.json schema) */
	schemaImports: ImportRef[]
	/** a Postgres array's declared dimensions; 0 or absent for a column of one value */
	dimensions?: number | undefined
	/** whether a Postgres array's elements may be null, as its drizzle type declares; false or absent otherwise */
	nullElements?: boolean | undefined
	/** the length the column itself declares (a varchar(n), a SQLite text({ length })); null when none. A `c` helper's declared max is in `constraints` */
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
	/** the indexed columns' property names, in index order */
	columns: string[]
	/** the index's name, which a violation of it reports */
	name: string
}

/** A partial (`.where()`) unique index: its columns are unique only among the rows `where` matches */
type PartialUniqueIndexMeta = UniqueIndexMeta & {
	/** the predicate, as the index's SQL holds it */
	where: string
}

/** A unique index whose keys are not all plain columns, keyed in the constraint map by its name */
type ExpressionIndexMeta = {
	/** its keys as SQL */
	expression: string
	/** the index's name, which a violation of it reports */
	name: string
}

/** Check constraint from table options */
type CheckConstraintMeta = {
	/** the condition every row must meet, as SQL */
	expression: string
	/** the constraint's name, which a violation of it reports */
	name: string
}

/** Timestamp tracking for a table */
type TimestampsMeta = {
	/** the creation time is comb's c.createdAt(), read back and NOT NULL, so the generated schemas use comb's shared timestamp fields for it */
	createdAt: boolean
	/** the soft-delete time is comb's c.deletedAt(), read back and nullable, so the generated schemas use comb's shared timestamp fields for it */
	deletedAt: boolean
	/** the property name of each epoch-millisecond column named createdAt, updatedAt or deletedAt in either casing; null when the table has none */
	names: {
		/** the creation time's property name, `createdAt` or `created_at`; null when none */
		createdAt: string | null
		/** the soft-delete time's property name, `deletedAt` or `deleted_at`; null when none */
		deletedAt: string | null
		/** the update time's property name, `updatedAt` or `updated_at`; null when none */
		updatedAt: string | null
	}
	/** the casing every timestamp shares; mixed when they differ, which no shared spread fits */
	style: "camelCase" | "mixed" | "snake_case"
	/** the update time is comb's c.updatedAt(), read back and NOT NULL, so the generated schemas use comb's shared timestamp fields for it */
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
	/** Partial (`.where()`) unique indexes on plain columns: the constraint map names their violations, and they are listed apart from the table's unique indexes */
	partialUniqueIndexes: PartialUniqueIndexMeta[]
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
	/** the names the tables file imports, which generated files import from the same modules */
	imports: ImportsMeta
	/** every table the tables file exports, in export order */
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
	PartialUniqueIndexMeta,
	UniqueIndexMeta,
}
