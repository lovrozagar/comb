/**
 * The types of a migration file as comb reads it: the schema its history leaves, and what its
 * statements risk. Declarations only.
 */

/* ═══════════════════════════════════════════════════════════════════════════
   PARSED MIGRATION
   ═══════════════════════════════════════════════════════════════════════════ */

/** A foreign key as a migration declares it; an empty `parentColumns` is the parent's primary key */
export type ForeignKey = {
	/** the table that holds the key */
	table: string
	/** its columns, in order */
	columns: string[]
	/** the table it references */
	parent: string
	/** the parent's columns it references, in order */
	parentColumns: string[]
	/** what a delete of a parent row does; `NO ACTION` when the migration says nothing */
	onDelete: "CASCADE" | "NO ACTION" | "RESTRICT" | "SET DEFAULT" | "SET NULL"
}

/** What a table rebuild must know of a table to save and restore its rows */
export type TableInfo = {
	/** its primary key's columns, in order; empty when it declares none */
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

/**
 * The schema a migration history leaves, followed statement by statement. A name is bare when its
 * object is in the schema comb migrates, else `schema.name`
 */
export type ExtractedSchema = {
	/** each table left, by name, with its column names */
	tables: Map<string, string[]>
	/** each index created, by name */
	indexes: string[]
	/** each table a DROP TABLE dropped, in order */
	droppedTables: string[]
	/** each foreign key of the tables left */
	foreignKeys: ForeignKey[]
	/**
	 * each trigger left, by its table, with the writes that fire it; `ftsSync` when its body only
	 * writes into an external-content FTS5 table (the sync triggers comb writes)
	 */
	triggers: Array<{
		/** the writes to `table` that fire it */
		events: TriggerEvent[]
		/** its body only writes into an external-content FTS5 table */
		ftsSync: boolean
		/** the trigger's name */
		name: string
		/** the table it is on */
		table: string
	}>
	/** the FTS5 tables whose text lives elsewhere (`content='src'`, or contentless `content=''`): a drop of one loses nothing */
	externalFts: string[]
	// pg-history.ts
	/**
	 * the statements of the history, in order: on Postgres, what its parse tree shows a write runs
	 * (parentage, defaults, rules, operators, casts) is read from them
	 */
	statements: string[]
	/** what a table rebuild must know of each table left, by name */
	tableInfo: Map<string, TableInfo>
}

/** How much a migration risks: `unsafe` loses data or breaks deployed code, `cautious` drops or changes something no row holds or is not one transaction, `safe` neither */
export type MigrationSafety = "safe" | "cautious" | "unsafe"

/** What a migration's statements risk, and which do */
export type MigrationClassification = {
	/** `unsafe` when any statement is, else `cautious` when any statement is, else `safe` */
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

/** A migration file, read and classified */
export type ParsedMigration = {
	/** the file's SQL, as written */
	sql: string
	/** the sha256 of the file's normalized SQL, which the history records for it */
	hash: string
	/** the file's name in the migrations folder */
	filename: string
	/** the file's statements, in order */
	statements: string[]
	/** what the file drops, as `DROP TABLE users` or `DROP COLUMN post.body` */
	drops: string[]
	/** the schema the file alone builds, on an empty database */
	expected: ExtractedSchema
	/** what the file's statements risk */
	classification: MigrationClassification
}
