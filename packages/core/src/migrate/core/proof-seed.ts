/**
 * The proof run's seed: six rows for each table of an in-memory copy of a database, chosen so a
 * change to any value shows. Row 0 takes every default; rows 1 to 3 hold discriminating values
 * (text that looks numeric, mixed case, non-ASCII, signed and large numbers), each column's three
 * distinct, and no two columns sharing a value in a row, so a copy or a swap between columns shows;
 * row 4 is NULL in every nullable column; rows 4 and 5 repeat row 1's values where the
 * table allows a duplicate, so a new UNIQUE … ON CONFLICT shows what it drops. A column checked
 * `IN (...)` takes its listed values, and a key column its parent's keys, parents seeded first. A
 * row the table refuses (a CHECK across columns, a range) takes its defaults, then each slot's values
 * in turn. A table whose six rows do not all go in is unproven: a partial seed could hide a loss.
 */
import type { MemoryDb } from "../drivers/memory.ts"
import { affinityOf } from "./sqlite-affinity.ts"

type Column = {
	hasDefault: boolean
	/** its position in the table, which sets its values apart from every other column's */
	index: number
	insertable: boolean
	name: string
	nullable: boolean
	type: string
	unique: boolean
}
/** A foreign key: its columns, the table they reference, and the referenced columns (none: its primary key) */
type Key = { from: string[]; table: string; to: string[] }

/* by affinity: slots 0 to 2 for rows 1 to 3, slot 3 for row 0 where a column has no default, slots 4 and 5 for rows 4 and 5 when a duplicate is refused */
const VALUES: Readonly<Record<string, readonly unknown[]>> = {
	BLOB: ["007", 7, "Mixed Case", "ñandú Ü", 99, 100],
	INTEGER: [7, -1, 2_147_483_648, 42, 99, 100],
	NUMERIC: [10, 2.5, "x7", 3, 99, 100],
	REAL: [1.5, -0.25, 1e10, 3.25, 9.5, 10.5],
	TEXT: ["007", "Mixed Case", "ñandú Ü", "010", "Zz", "zZ 2"],
}
/* each row's slot: rows 4 and 5 repeat row 1, then take their own when the table refuses the repeat */
const REPEATING = [3, 0, 1, 2, 0, 0]
const FRESH = [3, 0, 1, 2, 4, 5]
const ROWS = 6

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** The columns of a table's primary key and UNIQUE indexes, which a repeated row may not repeat */
function uniqueColumns(db: MemoryDb, table: string): Set<string> {
	const out = new Set<string>()
	for (const index of db.all(`PRAGMA index_list(${quote(table)})`).filter((row) => row["unique"] === 1)) {
		for (const column of db.all(`PRAGMA index_info(${quote(String(index["name"]))})`)) out.add(String(column["name"]))
	}
	return out
}

/** The columns a table declares, by PRAGMA table_xinfo: a generated or hidden column takes no value */
function columnsOf(db: MemoryDb, table: string): Column[] {
	const unique = uniqueColumns(db, table)
	return db.all(`PRAGMA table_xinfo(${quote(table)})`).map((row, index) => ({
		hasDefault: row["dflt_value"] !== null,
		index,
		insertable: row["hidden"] === 0,
		name: String(row["name"]),
		nullable: row["notnull"] === 0 && row["pk"] === 0,
		type: String(row["type"]),
		unique: Number(row["pk"]) > 0 || unique.has(String(row["name"])),
	}))
}

/** A table's foreign keys, each column group of PRAGMA foreign_key_list together */
function keysOf(db: MemoryDb, table: string): Key[] {
	const keys = new Map<number, Key>()
	for (const row of db.all(`PRAGMA foreign_key_list(${quote(table)})`)) {
		const id = Number(row["id"])
		const key = keys.get(id) ?? { from: [], table: String(row["table"]).toLowerCase(), to: [] }
		key.from.push(String(row["from"]))
		if (row["to"] !== null) key.to.push(String(row["to"]))
		keys.set(id, key)
	}
	return [...keys.values()]
}

/** The values a CREATE TABLE checks a column against with `<column> IN ('a', 'b', …)`, if any */
function listedValues(sql: string, column: string): unknown[] | undefined {
	const name = column.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const listed = new RegExp(`CHECK\\s*\\(\\s*["\`[]?${name}["\`\\]]?\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, "i").exec(sql)?.[1]
	if (listed === undefined) return undefined
	return [...listed.matchAll(/'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)/g)].map((match) =>
		match[1] === undefined ? Number(match[2]) : match[1].replaceAll("''", "'"),
	)
}

/**
 * `value` made the column's own: a string gains its position's digits, a number moves a thousand
 * per position away from zero, so it keeps the sign, size and kind that make it discriminating
 */
function ownValue(value: unknown, index: number): unknown {
	if (index === 0) return value
	if (typeof value === "string") return `${value}${index}`
	const number = value as number
	return number + (number < 0 ? -1 : 1) * index * 1000
}

/** The value row `row` gives `column`, from its listed values (rotated by its position) or its affinity's */
function valueFor(column: Column, slot: number, listed: readonly unknown[] | undefined): unknown {
	if (listed !== undefined && listed.length > 0) return listed[(slot + 1 + column.index) % listed.length]
	return ownValue((VALUES[affinityOf(column.type)] as readonly unknown[])[slot], column.index)
}

/** The primary key columns of a parent, for a key that names none */
const primaryKeyOf = (db: MemoryDb, table: string): string[] =>
	db
		.all(`PRAGMA table_info(${quote(table)})`)
		.filter((row) => Number(row["pk"]) > 0)
		.toSorted((a, b) => Number(a["pk"]) - Number(b["pk"]))
		.map((row) => String(row["name"]))

/** What one table needs to be seeded: its definition, columns and keys, and the rows its parents hold */
type Seeding = {
	columns: Column[]
	keys: Key[]
	parents: ReadonlyMap<string, Array<Record<string, unknown>>>
	sql: string
}

/** Which values a row tries: its slot, and whether every column with a default takes it */
type Attempt = { defaults: boolean; row: number; slot: number }

/** Row `row` of a table: each column's value, a key's columns from a parent row, or nothing where a default fills it */
function rowOf(db: MemoryDb, seeding: Seeding, at: Attempt): Map<string, unknown> | undefined {
	const { row, slot } = at
	const values = new Map<string, unknown>()
	for (const column of seeding.columns.filter((each) => each.insertable)) {
		if (at.defaults && column.hasDefault) continue
		values.set(
			column.name,
			row === 4 && column.nullable
				? null
				: valueFor(column, column.unique ? (FRESH[row] as number) : slot, listedValues(seeding.sql, column.name)),
		)
	}
	for (const key of seeding.keys) if (!keyValues(db, seeding, { key, row, values })) return undefined
	return values
}

/**
 * A key's columns in row `row`, from a parent row (NULL in row 4 where every column may be NULL,
 * or when the parent has no rows); false when the parent has none and the key may not be NULL
 */
function keyValues(
	db: MemoryDb,
	seeding: Seeding,
	at: { key: Key; row: number; values: Map<string, unknown> },
): boolean {
	const { key, row, values } = at
	const parent = seeding.parents.get(key.table) ?? []
	const source = parent[row % Math.max(parent.length, 1)]
	const nullable = key.from.every((name) => seeding.columns.find((c) => c.name === name)?.nullable === true)
	if (source === undefined && !nullable) return false
	const to = key.to.length > 0 ? key.to : primaryKeyOf(db, key.table)
	for (const [i, name] of key.from.entries())
		values.set(name, source === undefined || (row === 4 && nullable) ? null : source[to[i] as string])
	return true
}

/** Insert one row of `table`, or say why it would not go in */
function insertRow(db: MemoryDb, table: string, values: ReadonlyMap<string, unknown>): string | undefined {
	const names = [...values.keys()]
	const sql =
		names.length === 0
			? `INSERT INTO ${quote(table)} DEFAULT VALUES`
			: `INSERT INTO ${quote(table)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
	try {
		db.run(sql, [...values.values()])
		return undefined
	} catch (error) {
		return (error as Error).message
	}
}

/**
 * What row `row` tries, in order: its repeat of row 1, its own slot, then, for a row the table
 * refuses, every default with each slot (row 0 takes every default from the start)
 */
function attempts(row: number): Attempt[] {
	const own = [...new Set([REPEATING[row] as number, FRESH[row] as number])]
	const withDefaults = [...new Set([...own, ...FRESH])].map((slot) => ({ defaults: true, row, slot }))
	return row === 0 ? withDefaults : [...own.map((slot) => ({ defaults: false, row, slot })), ...withDefaults]
}

/* why a row cannot go in when a key it may not leave NULL has no parent row to take */
const NO_PARENT = "a key it may not leave NULL references a table comb could not seed"

/** Insert row `row` of `table` by the first attempt the table takes; or why not, its first refusal */
function seedRow(db: MemoryDb, seeding: Seeding & { table: string }, row: number): string | undefined {
	let refusal: string | undefined
	for (const attempt of attempts(row)) {
		const values = rowOf(db, seeding, attempt)
		if (values === undefined) return NO_PARENT
		const refused = insertRow(db, seeding.table, values)
		if (refused === undefined) return undefined
		/* the first refusal names why: a fallback's is about its own values */
		refusal ??= refused
	}
	return refusal
}

/** Seed `table`: its six rows, a repeat of row 1 where the table allows one, or why a row would not go in */
function seedTable(db: MemoryDb, table: string, seeding: Seeding): string | undefined {
	for (let row = 0; row < ROWS; row++) {
		const failed = seedRow(db, { ...seeding, table }, row)
		if (failed !== undefined) return failed
	}
	return undefined
}

/** Tables in an order that puts each parent before its children; a cycle keeps the order it was given */
function parentsFirst(db: MemoryDb, tables: readonly string[]): string[] {
	const parentsOf = new Map(tables.map((table) => [table, keysOf(db, table).map((key) => key.table)]))
	const done: string[] = []
	const visit = (table: string, path: ReadonlySet<string>) => {
		if (done.includes(table) || path.has(table)) return
		for (const parent of parentsOf.get(table) as string[])
			if (parentsOf.has(parent)) visit(parent, new Set([...path, table]))
		done.push(table)
	}
	for (const table of tables) visit(table, new Set())
	return done
}

/**
 * Seed every table of `tables` (by name, each with its CREATE TABLE) in the copy; returns each
 * table comb could not seed, with why. Foreign keys are off while it seeds, and the seed is then
 * checked against them: a table whose rows break a key is unproven too.
 */
function seedTables(db: MemoryDb, tables: ReadonlyMap<string, string>): Map<string, string> {
	const unproven = new Map<string, string>()
	const parents = new Map<string, Array<Record<string, unknown>>>()
	db.exec("PRAGMA foreign_keys = OFF")
	for (const table of parentsFirst(db, [...tables.keys()])) {
		const seeding = {
			columns: columnsOf(db, table),
			keys: keysOf(db, table),
			parents,
			sql: tables.get(table) as string,
		}
		const failed = seedTable(db, table, seeding)
		if (failed !== undefined) unproven.set(table, failed)
		parents.set(table, db.all(`SELECT * FROM ${quote(table)}`))
	}
	for (const row of db.all("PRAGMA foreign_key_check")) {
		const table = String(row["table"]).toLowerCase()
		if (!unproven.has(table)) unproven.set(table, `its seeded rows break its key to ${String(row["parent"])}`)
	}
	return unproven
}

export { quote, seedTables }
