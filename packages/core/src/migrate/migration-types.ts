/**
 * The types of a migration file as comb reads it: the schema its history leaves, and what its
 * statements risk. Declarations only.
 */

/* ═══════════════════════════════════════════════════════════════════════════
   PARSED MIGRATION
   ═══════════════════════════════════════════════════════════════════════════ */

/** A foreign key as a migration declares it; an empty `parentColumns` is the parent's primary key */
export type ForeignKey = {
	table: string
	columns: string[]
	parent: string
	parentColumns: string[]
	onDelete: "CASCADE" | "NO ACTION" | "RESTRICT" | "SET DEFAULT" | "SET NULL"
}

/** What a table rebuild must know of a table to save and restore its rows */
export type TableInfo = {
	primaryKey: string[]
	/** a WITHOUT ROWID table, whose rows are saved by primary key */
	withoutRowid: boolean
	/** its primary key is the rowid: a lone INTEGER column, so writing the key writes the rowid */
	rowidAlias: boolean
	/** columns no INSERT may write */
	generatedColumns: string[]
	/** SQLite keeps its next id in sqlite_sequence */
	autoincrement: boolean
	/** each column's type affinity by SQLite's rules: INTEGER, TEXT, BLOB, REAL or NUMERIC */
	affinity: Record<string, string>
	/** each ON CONFLICT resolution other than ABORT the table declares, as `<column or key>: <resolution>` */
	conflicts: string[]
	/** a STRICT table, which refuses a value of another type */
	strict: boolean
}

/** A write that fires a trigger */
export type TriggerEvent = "delete" | "insert" | "update"

export type ExtractedSchema = {
	tables: Map<string, string[]>
	indexes: string[]
	droppedTables: string[]
	foreignKeys: ForeignKey[]
	/**
	 * each trigger left, by its table, with the writes that fire it; `ftsSync` when its body only
	 * writes into an external-content FTS5 table (the sync triggers comb writes)
	 */
	triggers: Array<{ events: TriggerEvent[]; ftsSync: boolean; name: string; table: string }>
	/** the FTS5 tables whose text lives elsewhere (`content='src'`, or contentless `content=''`): a drop of one loses nothing */
	externalFts: string[]
	/**
	 * the statements of the history, in order: on Postgres, what its parse tree shows a write runs
	 * (parentage, defaults, rules, operators, casts) is read from them (pg-history.ts)
	 */
	statements: string[]
	tableInfo: Map<string, TableInfo>
}

export type MigrationSafety = "safe" | "cautious" | "unsafe"

export type MigrationClassification = {
	safety: MigrationSafety
	/** statements that lose data or break deployed code by name */
	unsafeStatements: string[]
	/** statements that drop or change something no row holds, or a file that is not one transaction */
	cautiousStatements: string[]
	/** Postgres statements that block a table while they run, with what to do instead */
	lockWarnings: string[]
	/**
	 * the SQLite writes among `unsafeStatements` the classifier could not clear on its own, pending
	 * the proof run's read of what each writes; the proof's findings replace them
	 */
	pendingStatements: string[]
}

export type ParsedMigration = {
	sql: string
	hash: string
	filename: string
	statements: string[]
	drops: string[]
	expected: ExtractedSchema
	classification: MigrationClassification
}
