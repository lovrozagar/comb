/**
 * TableMeta — serializable intermediate format produced by TableAnalyzer.
 * No ts-morph or Drizzle dependencies. All generators consume this.
 */

/** Constraint annotations parsed from field type arguments */
type FieldConstraintsMeta = {
	autogenerate: boolean
	email: boolean
	lowercase: boolean
	max: number | null
	maxBytes: number | null
	min: number | null
	nomutate: boolean
	password: boolean
	pattern: string | null
	private: boolean
	tenant: boolean
	trim: boolean
	uppercase: boolean
	url: boolean
}

/** Foreign key reference from this field to another table */
type ForeignKeyRef = {
	column: string
	onDelete?: string | undefined
	onUpdate?: string | undefined
	refColumn: string
	refTable: string
}

/** A single column/field in a table */
type FieldMeta = {
	constraints: FieldConstraintsMeta
	/** Drizzle helper: "text", "integer", "boolean", "timestamp", "createdAt", etc. */
	drizzleHelper: string
	/** Enum constant name if .$type<(typeof X)[number]> or c.enum("name", X) */
	enumName: string | null
	/** Inline enum values if c.enum("name", ["a", "b"]), null if const ref */
	enumValues: string[] | null
	/** FK reference if .references(() => table.column) */
	foreignKey: ForeignKeyRef | null
	/** Whether .notNull() is present */
	isNotNull: boolean
	/** Whether .primaryKey() or c.id("prefix") */
	isPrimaryKey: boolean
	/** JSON schema name if c.json("name", schemaName) */
	jsonSchemaName: string | null
	/** Length from positional arg or constraints */
	length: number | null
	/** Field name as defined in the table schema object */
	name: string
	/** Full raw text of the initializer expression */
	raw: string
}

/** Unique index from table options (3rd arg arrow function) */
type UniqueIndexMeta = {
	columns: string[]
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
	style: "camelCase" | "snake_case"
	updatedAt: boolean
}

/** Complete metadata for a single table */
type TableMeta = {
	/** Check constraints from table options */
	checkConstraints: CheckConstraintMeta[]
	/** All fields in the table */
	fields: FieldMeta[]
	/** Whether composite PK exists in table options */
	hasCompositePrimaryKey: boolean
	/** Entity ID prefix from c.id("prefix"), null if c.serialId() or missing */
	idPrefix: string | null
	/** SQL table name (first arg to createTable) */
	sqlName: string
	/** Detected timestamp fields and style */
	timestamps: TimestampsMeta
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

/** Full analysis result */
type AnalysisResult = {
	/** Database name derived from tables file path */
	dbName: string
	imports: ImportsMeta
	tables: TableMeta[]
	/** Relative import path for the tables file */
	tablesImportPath: string
}

export type {
	AnalysisResult,
	CheckConstraintMeta,
	FieldConstraintsMeta,
	FieldMeta,
	ForeignKeyRef,
	ImportsMeta,
	TableMeta,
	TimestampsMeta,
	UniqueIndexMeta,
}
