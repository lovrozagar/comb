/**
 * What one CREATE TABLE declares, read from its code: its columns, its foreign keys (inline and
 * table-level), and its shape (primary key, rowid alias, generated columns, AUTOINCREMENT,
 * WITHOUT ROWID, STRICT, each column's affinity and the conflict resolutions it declares).
 */
import type { ForeignKey, TableInfo } from "../types.ts"
import { IDENT, lastPart, nameKey, type Naming, QNAME, splitTopLevel } from "./sql-code.ts"
import { conflictsOf, definitionAffinity, isStrict } from "./sqlite-affinity.ts"

const CONSTRAINT_WORDS: RegExp = /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)/i

// per-process-constant: patterns composed from the name grammar, compiled once
const TABLE_FK = /* @__PURE__ */ new RegExp(
	`^(?:CONSTRAINT ${IDENT} )?FOREIGN KEY ?\\(([^)]*)\\) ?REFERENCES (${QNAME}) ?(?:\\(([^)]*)\\))?(.*)$`,
	"i",
)
// per-process-constant: see above
const COLUMN_REF = /* @__PURE__ */ new RegExp(`\\bREFERENCES (${QNAME}) ?(?:\\(([^)]*)\\))?(.*)$`, "i")
// per-process-constant: see above
const TABLE_PK = /* @__PURE__ */ new RegExp(`^(?:CONSTRAINT ${IDENT} )?PRIMARY KEY ?\\(([^)]*)\\)`, "i")
// per-process-constant: see above
const COLUMN: RegExp = /* @__PURE__ */ new RegExp(`^(${IDENT})(?: (.*))?$`, "i")
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
function columnNames(code: string): string[] {
	return bodyParts(code)
		.map((def) => COLUMN.exec(def)?.[1])
		.filter((name): name is string => name !== undefined && !CONSTRAINT_WORDS.test(name))
		.map(lastPart)
}

const GENERATED: RegExp = /\b(?:GENERATED ALWAYS )?AS ?\(/i

const names = (list: string): string[] => splitTopLevel(list).map(lastPart)

/** A table-level key's columns, each without its COLLATE and sort order */
const keyNames = (list: string): string[] =>
	splitTopLevel(list).map((part) => lastPart(part.replace(/(?:\s+COLLATE\s+\S+)?(?:\s+(?:ASC|DESC))?\s*$/i, "")))

const onDeleteOf = (rest: string): ForeignKey["onDelete"] =>
	(/\bON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)\b/i.exec(rest)?.[1]?.toUpperCase() ??
		"NO ACTION") as ForeignKey["onDelete"]

/** The foreign key a column definition declares inline, if any */
function columnKey(definition: string, at: { column: string; naming: Naming; table: string }): ForeignKey | undefined {
	const { column, naming, table } = at
	const [, parent, parentColumns, rest] = COLUMN_REF.exec(definition) ?? []
	if (parent === undefined) return undefined
	const onDelete = onDeleteOf(rest as string)
	return {
		columns: [column],
		onDelete,
		parent: nameKey(parent, naming),
		parentColumns: names(parentColumns ?? ""),
		table,
	}
}

/** A CREATE TABLE being read: its keys and shape so far, and each column's definition by name */
type Reading = {
	definitions: Map<string, string>
	naming: Naming
	info: TableInfo
	keys: ForeignKey[]
	table: string
}

/** One column: its definition decides its affinity, its rowid alias, whether it is generated, and its key */
function readColumn(column: string, definition: string, into: Reading): void {
	const { naming, info, keys, table } = into
	into.definitions.set(column, definition)
	info.affinity[column] = definitionAffinity(definition)
	if (/\bPRIMARY KEY\b/i.test(definition)) info.primaryKey = [column]
	if (GENERATED.test(definition)) info.generatedColumns.push(column)
	const key = columnKey(definition, { column, naming, table })
	if (key !== undefined) keys.push(key)
}

/** One part of a CREATE TABLE body: a table-level foreign key, a table-level key, or a column */
function readPart(part: string, into: Reading): void {
	const [, columns, parent, parentColumns, rest] = TABLE_FK.exec(part) ?? []
	if (columns !== undefined) {
		into.keys.push({
			columns: names(columns),
			onDelete: onDeleteOf(rest as string),
			parent: nameKey(parent as string, into.naming),
			parentColumns: names(parentColumns ?? ""),
			table: into.table,
		})
		return
	}
	const primary = TABLE_PK.exec(part)?.[1]
	if (primary !== undefined) into.info.primaryKey = keyNames(primary)
	const [, name, definition = ""] = COLUMN.exec(part) ?? []
	const column = name === undefined || CONSTRAINT_WORDS.test(name) ? undefined : lastPart(name)
	into.info.conflicts.push(...conflictsOf(part, column))
	if (column !== undefined && primary === undefined) readColumn(column, definition, into)
}

/** What a CREATE TABLE's code declares: its keys and its shape */
function tableDefinition(code: string, table: string, naming: Naming): { info: TableInfo; keys: ForeignKey[] } {
	const into: Reading = {
		definitions: new Map(),
		naming,
		info: {
			affinity: {},
			autoincrement: /\bAUTOINCREMENT\b/i.test(code),
			conflicts: [],
			generatedColumns: [],
			primaryKey: [],
			rowidAlias: false,
			strict: isStrict(code),
			withoutRowid: /\)[^()]*\bWITHOUT ROWID\b[^()]*$/i.test(code),
		},
		keys: [],
		table,
	}
	for (const part of bodyParts(code)) readPart(part, into)
	into.info.rowidAlias = rowidAliasOf(into.info, into.definitions)
	return { info: into.info, keys: into.keys }
}

/* a column declared exactly INTEGER, then nothing or its constraints */
const INTEGER_COLUMN =
	/^INTEGER(?:\s+(?:CONSTRAINT|NOT|NULL|PRIMARY|UNIQUE|CHECK|DEFAULT|COLLATE|REFERENCES|GENERATED|AS)\b.*)?$/is

/**
 * Whether a table's key is its rowid: a lone key column declared exactly INTEGER, in a rowid
 * table, and not an inline `PRIMARY KEY DESC`, which SQLite keeps apart from the rowid
 */
function rowidAliasOf({ primaryKey, withoutRowid }: TableInfo, definitions: ReadonlyMap<string, string>): boolean {
	const [lone, ...more] = primaryKey
	if (withoutRowid || lone === undefined || more.length > 0) return false
	const definition = definitions.get(lone) ?? ""
	return INTEGER_COLUMN.test(definition) && !/\bPRIMARY KEY DESC\b/i.test(definition)
}

export { COLUMN, columnKey, columnNames, CONSTRAINT_WORDS, GENERATED, tableDefinition }
