/**
 * The schema a sequence of migrations leaves, read statement by statement: each table's columns,
 * keys and shape, the indexes, the dropped tables, the triggers and the routines. The classifier
 * reads a file against it, and the SQLite rebuild guard finds the tables a rebuild reaches by it.
 */
import { codeOf, dialectOf, IDENT, lastPart, nameKey, type Naming, namingOf, QNAME, splitTopLevel } from "./sql-code.ts"
import { type PgRead, pgRead, recordRead } from "./pg-split.ts"
import { normalizeSql, splitSqlStatements } from "./sql-scan.ts"
import { syncTriggerOf } from "./fts-sync.ts"
import { COLUMN, columnKey, columnNames, CONSTRAINT_WORDS, GENERATED, tableDefinition } from "./schema-table.ts"
import { definitionAffinity } from "./sqlite-affinity.ts"
import type { Dialect, ExtractedSchema, TriggerEvent } from "../types.ts"

type SchemaSoFar = ExtractedSchema

// per-process-constant: patterns composed from the name grammar, compiled once
const TABLE_DEFINITION = /* @__PURE__ */ new RegExp(
	`^CREATE (?:TEMP |TEMPORARY )?TABLE (?:IF NOT EXISTS )?(${QNAME}) ?\\(`,
	"i",
)
// per-process-constant: see above
const ADD_COLUMN = /* @__PURE__ */ new RegExp(`^ALTER TABLE (${QNAME}) ADD (?:COLUMN )?(${IDENT} .*)$`, "i")
// per-process-constant: see above
const CREATE_INDEX = /* @__PURE__ */ new RegExp(`^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(${QNAME})`, "i")
// per-process-constant: see above
const ADDS_OR_DROPS = /* @__PURE__ */ new RegExp(`^ALTER TABLE (${QNAME}) (ADD|DROP) (?:COLUMN )?(${IDENT})`, "i")
// per-process-constant: see above
const RENAMES_COLUMN = /* @__PURE__ */ new RegExp(
	`^ALTER TABLE (${QNAME}) RENAME (?:COLUMN )?(${IDENT}) TO (${IDENT})`,
	"i",
)
// per-process-constant: see above
const DROPS_TABLES = /* @__PURE__ */ new RegExp(`^DROP TABLE (?:IF EXISTS )?(${QNAME}(?: ?, ?${QNAME})*)`, "i")
// per-process-constant: see above
const RENAMES_TABLE = /* @__PURE__ */ new RegExp(`^ALTER TABLE (${QNAME}) RENAME TO (${QNAME})$`, "i")
// per-process-constant: see above
const CREATE_TRIGGER = /* @__PURE__ */ new RegExp(
	`^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?(?:TEMP |TEMPORARY )?TRIGGER (?:IF NOT EXISTS )?(${QNAME}) (.*?)\\bON (${QNAME})`,
	"i",
)
// per-process-constant: see above
const DROP_TRIGGER = /* @__PURE__ */ new RegExp(`^DROP TRIGGER (?:IF EXISTS )?(${QNAME})`, "i")
// per-process-constant: an FTS5 table and its arguments, composed once
const CREATE_FTS = /* @__PURE__ */ new RegExp(
	`^CREATE VIRTUAL TABLE (?:IF NOT EXISTS )?(${QNAME}) USING fts5 ?\\(.*\\)$`,
	"i",
)

/** What an ALTER TABLE ADD, DROP or RENAME COLUMN does to a followed table's columns */
function followColumns(schema: SchemaSoFar, code: string, naming: Naming): void {
	const [, altered, verb, added] = ADDS_OR_DROPS.exec(code) ?? []
	const table = altered === undefined ? undefined : nameKey(altered, naming)
	const columns = table === undefined ? undefined : schema.tables.get(table)
	const column = added === undefined ? "" : lastPart(added)
	if (columns !== undefined && !CONSTRAINT_WORDS.test(column)) {
		const kept = columns.filter((name) => name !== column)
		schema.tables.set(table as string, verb?.toUpperCase() === "ADD" ? [...kept, column] : kept)
	}
	const [, renamedIn, from, to] = RENAMES_COLUMN.exec(code) ?? []
	const inTable = renamedIn === undefined ? undefined : nameKey(renamedIn, naming)
	const before = inTable === undefined ? undefined : schema.tables.get(inTable)
	if (before === undefined) return
	const [was, now] = [lastPart(from as string), lastPart(to as string)]
	schema.tables.set(
		inTable as string,
		before.map((name) => (name === was ? now : name)),
	)
}

/** A CREATE TABLE's keys and shape replace the table's; an ADD COLUMN adds its key and generated column */
function followTableShape(schema: SchemaSoFar, code: string, naming: Naming): void {
	const created = TABLE_DEFINITION.exec(code)?.[1]
	if (created !== undefined) {
		const table = nameKey(created, naming)
		const { info, keys } = tableDefinition(code, table, naming)
		schema.tables.set(table, columnNames(code))
		schema.foreignKeys = [...schema.foreignKeys.filter((fk) => fk.table !== table), ...keys]
		schema.tableInfo.set(table, info)
	}
	const [, alteredTable, added] = ADD_COLUMN.exec(code) ?? []
	if (alteredTable === undefined || added === undefined) return
	const table = nameKey(alteredTable, naming)
	const [, name, definition = ""] = COLUMN.exec(added) as RegExpExecArray
	const column = lastPart(name as string)
	const key = columnKey(definition, { column, naming, table })
	if (key !== undefined) schema.foreignKeys.push(key)
	const info = schema.tableInfo.get(table)
	if (info === undefined) return
	info.affinity[column] = definitionAffinity(definition)
	if (GENERATED.test(definition)) info.generatedColumns.push(column)
}

/** A DROP TABLE takes each table's keys, triggers and shape with it; a rename moves them */
function followTableLife(schema: SchemaSoFar, code: string, naming: Naming): void {
	const dropped = DROPS_TABLES.exec(code)?.[1]
	for (const table of dropped === undefined ? [] : splitTopLevel(dropped).map((name) => nameKey(name, naming))) {
		schema.droppedTables.push(table)
		schema.externalFts = schema.externalFts.filter((fts) => fts !== table)
		schema.tables.delete(table)
		schema.foreignKeys = schema.foreignKeys.filter((fk) => fk.table !== table)
		schema.triggers = schema.triggers.filter((trigger) => trigger.table !== table)
		schema.tableInfo.delete(table)
	}
	const [, from, to] = RENAMES_TABLE.exec(code) ?? []
	if (from !== undefined && to !== undefined) renameShapes(schema, nameKey(from, naming), nameKey(to, naming))
}

/**
 * SQLite triggers made and dropped. A Postgres history's triggers and routines are read from its
 * parse trees (pg-history.ts), which no spelling, rename or move hides.
 */
function followTriggers(schema: SchemaSoFar, [code, text]: [string, string], naming: Naming): void {
	if (naming !== "sqlite") return
	const key = (name: string) => nameKey(name, naming)
	const [, trigger, timing, on] = CREATE_TRIGGER.exec(code) ?? []
	if (trigger !== undefined) {
		/* what writes fire it: INSERT, UPDATE [OF …], DELETE, joined by OR on Postgres */
		const events = [
			...new Set(
				[...(timing as string).matchAll(/\b(INSERT|UPDATE|DELETE)\b/gi)].map((m) => (m[1] as string).toLowerCase()),
			),
		]
		schema.triggers.push({
			events: events as TriggerEvent[],
			ftsSync: syncTriggerOf(text, new Set(schema.externalFts), naming) !== undefined,
			name: key(trigger),
			table: key(on as string),
		})
	}
	const goneTrigger = DROP_TRIGGER.exec(code)?.[1]
	if (goneTrigger !== undefined) schema.triggers = schema.triggers.filter((t) => t.name !== key(goneTrigger))
}

/** A table renamed: its keys, the keys to it, its triggers and its shape follow the new name */
function renameShapes(schema: SchemaSoFar, from: string, to: string): void {
	const renamed = (name: string) => (name === from ? to : name)
	schema.externalFts = schema.externalFts.map(renamed)
	schema.foreignKeys = schema.foreignKeys.map((fk) => ({ ...fk, parent: renamed(fk.parent), table: renamed(fk.table) }))
	schema.triggers = schema.triggers.map((trigger) => ({ ...trigger, table: renamed(trigger.table) }))
	const columns = schema.tables.get(from)
	if (columns !== undefined) {
		schema.tables.delete(from)
		schema.tables.set(to, columns)
	}
	const info = schema.tableInfo.get(from)
	if (info === undefined) return
	schema.tableInfo.delete(from)
	schema.tableInfo.set(to, info)
}

/** What one statement does to the schema being followed, read from its code: a comment or a string names nothing */
function follow(schema: SchemaSoFar, stmt: string, naming: Naming): void {
	const code = codeOf(stmt, dialectOf(naming))
	followTableShape(schema, code, naming)
	followTableLife(schema, code, naming)
	/* the sync rule reads the 'delete' command, a literal codeOf blanks (M43) */
	followTriggers(schema, [code, normalizeSql(stmt).replace(/;$/, "")], naming)
	followColumns(schema, code, naming)
	const index = CREATE_INDEX.exec(code)?.[1]
	if (index !== undefined) schema.indexes.push(nameKey(index, naming))
	const fts = CREATE_FTS.exec(code)?.[1]
	/* codeOf blanks a string to one space, so content='src' and content='' read alike: both keep no text */
	if (fts !== undefined && /\bcontent ?= ?'/i.test(stmt)) schema.externalFts.push(nameKey(fts, naming))
}

/** The schema before any migration */
const EMPTY: ExtractedSchema = {
	droppedTables: [],
	externalFts: [],
	foreignKeys: [],
	indexes: [],
	statements: [],
	tableInfo: /* @__PURE__ */ new Map(),
	tables: /* @__PURE__ */ new Map(),
	triggers: [],
}

/**
 * The tables (with columns, keys and shape), indexes, dropped tables, triggers and routines a
 * migration leaves, after `from` when given, read as `readAs` names a dialect; a Postgres name keyed
 * under `readAs.schema`, the schema comb's URLs set as search_path, public unnamed (M72). Postgres
 * text is read as the statements Postgres runs, by its parser: `loadPostgresParser()` first (M75)
 */
function extractSchema(
	sql: string,
	from: ExtractedSchema = EMPTY,
	readAs: Dialect | { dialect: Dialect; schema?: string | undefined } = "sqlite",
): ExtractedSchema {
	const as = typeof readAs === "string" ? { dialect: readAs } : readAs
	return schemaOfRead({ read: as.dialect === "postgres" ? pgRead(sql) : undefined, sql }, as, from)
}

/**
 * extractSchema of a file its caller has read: on Postgres `read` is its one parse, shared with the
 * file's classification (M86); undefined, the file is read as SQLite
 */
function schemaOfRead(
	{ read, sql }: { read: PgRead | undefined; sql: string },
	{ dialect, schema: searchSchema }: { dialect: Dialect; schema?: string | undefined },
	from: ExtractedSchema = EMPTY,
): ExtractedSchema {
	const naming = namingOf(dialect, searchSchema)
	const schema: SchemaSoFar = {
		droppedTables: [...from.droppedTables],
		externalFts: [...from.externalFts],
		foreignKeys: [...from.foreignKeys],
		indexes: [...from.indexes],
		statements: [...from.statements],
		tableInfo: new Map(
			[...from.tableInfo].map(([table, info]) => [
				table,
				{
					...info,
					affinity: { ...info.affinity },
					conflicts: [...info.conflicts],
					generatedColumns: [...info.generatedColumns],
				},
			]),
		),
		tables: new Map(from.tables),
		triggers: [...from.triggers],
	}
	/* on Postgres, the statements Postgres runs: Atlas's chunks read by its parser (M75) */
	for (const stmt of read === undefined ? splitSqlStatements(sql) : read.statements.map(({ text }) => text)) {
		follow(schema, stmt, naming)
		schema.statements.push(stmt)
	}
	if (read !== undefined) recordRead(schema, from, read)
	return schema
}

export { extractSchema, schemaOfRead }
