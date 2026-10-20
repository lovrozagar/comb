/**
 * The schema a sequence of migrations leaves, read statement by statement: each table's columns,
 * keys and shape, the indexes, the dropped tables, the triggers and the routines. The classifier
 * reads a file against it, and the SQLite rebuild guard finds the tables a rebuild reaches by it.
 */
import { codeOf, IDENT, lastPart, QNAME, splitTopLevel } from "./sql-code.ts"
import { splitSqlStatements } from "./sql-scan.ts"
import type { Dialect, ExtractedSchema, ForeignKey, TableInfo } from "../types.ts"

const CONSTRAINT_WORDS = /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)/i

/** The column definitions of a CREATE TABLE body: its top-level comma-separated parts */
function bodyParts(stmt: string): string[] {
	const open = stmt.indexOf("(")
	const parts: string[] = []
	let depth = 0
	let start = open + 1
	for (let i = open + 1; i < stmt.length; i++) {
		const char = stmt[i]
		if (char === "(") depth++
		else if (char === ")" && depth === 0) return [...parts, stmt.slice(start, i).trim()]
		else if (char === ")") depth--
		else if (char === "," && depth === 0) {
			parts.push(stmt.slice(start, i).trim())
			start = i + 1
		}
	}
	return [...parts, stmt.slice(start).trim()]
}

/** The column names a CREATE TABLE declares, table constraints left out */
function columnNames(stmt: string): string[] {
	return bodyParts(stmt)
		.map((def) => /^["'`]?(\w+)["'`]?(?:\s|$)/.exec(def)?.[1])
		.filter((name): name is string => name !== undefined && !CONSTRAINT_WORDS.test(name))
}

type SchemaSoFar = ExtractedSchema

const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s*\(/i
const CREATE_INDEX = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i
const DROP_TABLE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i
/* Atlas's table rebuild: create `new_t`, copy rows, drop `t`, rename `new_t` to `t` */
const RENAME_TABLE = /ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+RENAME\s+TO\s+["'`]?(\w+)["'`]?/i

const ADDS_OR_DROPS = /^\s*ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+(ADD|DROP)\s+(?:COLUMN\s+)?["'`]?(\w+)/i
const RENAMES_COLUMN =
	/^\s*ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+RENAME\s+(?:COLUMN\s+)?["'`]?(\w+)["'`]?\s+TO\s+["'`]?(\w+)/i

/** What an ALTER TABLE ADD, DROP or RENAME COLUMN does to a followed table's columns */
function followColumns(schema: SchemaSoFar, stmt: string): void {
	const [, table, verb, column] = ADDS_OR_DROPS.exec(stmt) ?? []
	const columns = table === undefined ? undefined : schema.tables.get(table)
	if (columns !== undefined && !/^(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)$/i.test(column as string)) {
		const kept = columns.filter((name) => name !== column)
		schema.tables.set(table as string, verb?.toUpperCase() === "ADD" ? [...kept, column as string] : kept)
	}
	const [, renamedIn, from, to] = RENAMES_COLUMN.exec(stmt) ?? []
	const before = renamedIn === undefined ? undefined : schema.tables.get(renamedIn)
	if (before !== undefined)
		schema.tables.set(
			renamedIn as string,
			before.map((name) => (name === from ? (to as string) : name)),
		)
}

// per-process-constant: patterns composed from the name grammar, compiled once
const TABLE_DEFINITION = /* @__PURE__ */ new RegExp(
	`^CREATE (?:TEMP |TEMPORARY )?TABLE (?:IF NOT EXISTS )?(${QNAME}) ?\\(`,
	"i",
)
// per-process-constant: see above
const TABLE_FK = /* @__PURE__ */ new RegExp(
	`^(?:CONSTRAINT ${IDENT} )?FOREIGN KEY ?\\(([^)]*)\\) ?REFERENCES (${QNAME}) ?(?:\\(([^)]*)\\))?(.*)$`,
	"i",
)
// per-process-constant: see above
const COLUMN_REF = /* @__PURE__ */ new RegExp(`\\bREFERENCES (${QNAME}) ?(?:\\(([^)]*)\\))?(.*)$`, "i")
// per-process-constant: see above
const TABLE_PK = /* @__PURE__ */ new RegExp(`^(?:CONSTRAINT ${IDENT} )?PRIMARY KEY ?\\(([^)]*)\\)`, "i")
// per-process-constant: see above
const COLUMN = /* @__PURE__ */ new RegExp(`^(${IDENT})(?: (.*))?$`, "i")
// per-process-constant: see above
const ADD_COLUMN = /* @__PURE__ */ new RegExp(`^ALTER TABLE (${QNAME}) ADD (?:COLUMN )?(${IDENT} .*)$`, "i")
// per-process-constant: see above
const DROPS_TABLES = /* @__PURE__ */ new RegExp(`^DROP TABLE (?:IF EXISTS )?(${QNAME}(?: ?, ?${QNAME})*)`, "i")
// per-process-constant: see above
const RENAMES_TABLE = /* @__PURE__ */ new RegExp(`^ALTER TABLE (${QNAME}) RENAME TO (${QNAME})$`, "i")
// per-process-constant: see above
const CREATE_TRIGGER = /* @__PURE__ */ new RegExp(
	`^CREATE (?:TEMP |TEMPORARY )?TRIGGER (?:IF NOT EXISTS )?(${QNAME}) .*?\\bON (${QNAME})`,
	"i",
)
// per-process-constant: see above
const DROP_TRIGGER = /* @__PURE__ */ new RegExp(`^DROP TRIGGER (?:IF EXISTS )?(${QNAME})`, "i")
// per-process-constant: see above
const CREATE_ROUTINE = /* @__PURE__ */ new RegExp(`^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE) (${QNAME})`, "i")
// per-process-constant: see above
const DROP_ROUTINE = /* @__PURE__ */ new RegExp(`^DROP (?:FUNCTION|PROCEDURE) (?:IF EXISTS )?(${QNAME})`, "i")
const GENERATED = /\b(?:GENERATED ALWAYS )?AS ?\(/i

const names = (list: string): string[] => splitTopLevel(list).map(lastPart)

const onDeleteOf = (rest: string): ForeignKey["onDelete"] =>
	(/\bON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)\b/i.exec(rest)?.[1]?.toUpperCase() ??
		"NO ACTION") as ForeignKey["onDelete"]

/** The foreign key a column definition declares inline, if any */
function columnKey(table: string, column: string, definition: string): ForeignKey | undefined {
	const [, parent, parentColumns, rest] = COLUMN_REF.exec(definition) ?? []
	if (parent === undefined) return undefined
	const onDelete = onDeleteOf(rest as string)
	return { columns: [column], onDelete, parent: lastPart(parent), parentColumns: names(parentColumns ?? ""), table }
}

/** What a CREATE TABLE's code declares: its keys and its shape */
function tableDefinition(code: string, table: string): { info: TableInfo; keys: ForeignKey[] } {
	const keys: ForeignKey[] = []
	const info: TableInfo = {
		autoincrement: /\bAUTOINCREMENT\b/i.test(code),
		generatedColumns: [],
		primaryKey: [],
		withoutRowid: /\)[^()]*\bWITHOUT ROWID\b[^()]*$/i.test(code),
	}
	for (const part of bodyParts(code)) {
		const [, columns, parent, parentColumns, rest] = TABLE_FK.exec(part) ?? []
		if (columns !== undefined) {
			const onDelete = onDeleteOf(rest as string)
			keys.push({
				columns: names(columns),
				onDelete,
				parent: lastPart(parent as string),
				parentColumns: names(parentColumns ?? ""),
				table,
			})
			continue
		}
		const primary = TABLE_PK.exec(part)?.[1]
		if (primary !== undefined) info.primaryKey = names(primary)
		const [, name, definition = ""] = COLUMN.exec(part) ?? []
		if (name === undefined || CONSTRAINT_WORDS.test(name) || primary !== undefined) continue
		const column = lastPart(name)
		if (/\bPRIMARY KEY\b/i.test(definition)) info.primaryKey = [column]
		if (GENERATED.test(definition)) info.generatedColumns.push(column)
		const key = columnKey(table, column, definition)
		if (key !== undefined) keys.push(key)
	}
	return { info, keys }
}

/** A CREATE TABLE's keys and shape replace the table's; an ADD COLUMN adds its key and generated column */
function followTableShape(schema: SchemaSoFar, code: string): void {
	const created = TABLE_DEFINITION.exec(code)?.[1]
	if (created !== undefined) {
		const table = lastPart(created)
		const { info, keys } = tableDefinition(code, table)
		schema.foreignKeys = [...schema.foreignKeys.filter((fk) => fk.table !== table), ...keys]
		schema.tableInfo.set(table, info)
	}
	const [, alteredTable, added] = ADD_COLUMN.exec(code) ?? []
	if (alteredTable === undefined || added === undefined) return
	const table = lastPart(alteredTable)
	const [, name, definition = ""] = COLUMN.exec(added) as RegExpExecArray
	const column = lastPart(name as string)
	const key = columnKey(table, column, definition)
	if (key !== undefined) schema.foreignKeys.push(key)
	const info = schema.tableInfo.get(table)
	if (info !== undefined && GENERATED.test(definition)) info.generatedColumns.push(column)
}

/** A DROP TABLE takes each table's keys, triggers and shape with it; a rename moves them */
function followTableLife(schema: SchemaSoFar, code: string): void {
	const dropped = DROPS_TABLES.exec(code)?.[1]
	for (const table of dropped === undefined ? [] : names(dropped)) {
		schema.foreignKeys = schema.foreignKeys.filter((fk) => fk.table !== table)
		schema.triggers = schema.triggers.filter((trigger) => trigger.table !== table)
		schema.tableInfo.delete(table)
	}
	const [, from, to] = RENAMES_TABLE.exec(code) ?? []
	if (from !== undefined && to !== undefined) renameShapes(schema, lastPart(from), lastPart(to))
}

/** Triggers and routines made and dropped */
function followRoutines(schema: SchemaSoFar, code: string): void {
	const [, trigger, on] = CREATE_TRIGGER.exec(code) ?? []
	if (trigger !== undefined) schema.triggers.push({ name: lastPart(trigger), table: lastPart(on as string) })
	const goneTrigger = DROP_TRIGGER.exec(code)?.[1]
	if (goneTrigger !== undefined) schema.triggers = schema.triggers.filter((t) => t.name !== lastPart(goneTrigger))
	const routine = CREATE_ROUTINE.exec(code)?.[1]
	if (routine !== undefined && !schema.functions.includes(lastPart(routine))) schema.functions.push(lastPart(routine))
	const goneRoutine = DROP_ROUTINE.exec(code)?.[1]
	if (goneRoutine !== undefined) schema.functions = schema.functions.filter((name) => name !== lastPart(goneRoutine))
}

/** A table renamed: its keys, the keys to it, its triggers and its shape follow the new name */
function renameShapes(schema: SchemaSoFar, from: string, to: string): void {
	const renamed = (name: string) => (name === from ? to : name)
	schema.foreignKeys = schema.foreignKeys.map((fk) => ({ ...fk, parent: renamed(fk.parent), table: renamed(fk.table) }))
	schema.triggers = schema.triggers.map((trigger) => ({ ...trigger, table: renamed(trigger.table) }))
	const info = schema.tableInfo.get(from)
	if (info === undefined) return
	schema.tableInfo.delete(from)
	schema.tableInfo.set(to, info)
}

/** What one statement does to the schema being followed */
function follow(schema: SchemaSoFar, stmt: string, dialect: Dialect): void {
	const code = codeOf(stmt, dialect)
	followTableShape(schema, code)
	followTableLife(schema, code)
	followRoutines(schema, code)
	const created = CREATE_TABLE.exec(stmt)?.[1]
	if (created !== undefined) schema.tables.set(created, columnNames(stmt))
	const index = CREATE_INDEX.exec(stmt)?.[1]
	if (index !== undefined) schema.indexes.push(index)
	const dropped = DROP_TABLE.exec(stmt)?.[1]
	if (dropped !== undefined) {
		schema.droppedTables.push(dropped)
		schema.tables.delete(dropped)
	}
	followColumns(schema, stmt)
	const [, from, to] = RENAME_TABLE.exec(stmt) ?? []
	const columns = from === undefined ? undefined : schema.tables.get(from)
	if (columns !== undefined && to !== undefined) {
		schema.tables.delete(from as string)
		schema.tables.set(to, columns)
	}
}

/** The schema before any migration */
const EMPTY: ExtractedSchema = {
	droppedTables: [],
	foreignKeys: [],
	functions: [],
	indexes: [],
	tableInfo: /* @__PURE__ */ new Map(),
	tables: /* @__PURE__ */ new Map(),
	triggers: [],
}

/**
 * The tables (with columns, keys and shape), indexes, dropped tables, triggers and routines a
 * migration leaves, after `from` when given, read as `dialect` reads it
 */
function extractSchema(sql: string, from: ExtractedSchema = EMPTY, dialect: Dialect = "sqlite"): ExtractedSchema {
	const schema: SchemaSoFar = {
		droppedTables: [...from.droppedTables],
		foreignKeys: [...from.foreignKeys],
		functions: [...from.functions],
		indexes: [...from.indexes],
		tableInfo: new Map(
			[...from.tableInfo].map(([table, info]) => [table, { ...info, generatedColumns: [...info.generatedColumns] }]),
		),
		tables: new Map(from.tables),
		triggers: [...from.triggers],
	}
	for (const stmt of splitSqlStatements(sql, dialect)) follow(schema, stmt, dialect)
	return schema
}

export { extractSchema }
