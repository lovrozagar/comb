/**
 * The proof run's seed: six rows for each table of an in-memory copy of a database, chosen so a
 * change to any value shows. Row 0 takes every default; rows 1 to 3 hold discriminating values
 * (text that looks numeric, mixed case, non-ASCII, signed and large numbers), each column's three
 * distinct, and no two columns sharing a value in a row, so a copy or a swap between columns shows;
 * row 4 is NULL in every nullable column. No value repeats down a column, and an INTEGER primary
 * key starts past 2^40, an id no migration writes: a file's new unique index or explicit id meets
 * no seeded row. A column checked `IN (...)` takes its listed values, and a key column its parent's
 * keys, parents seeded first (a self-reference, the row before it). A row the table refuses (a
 * CHECK across columns, a range, a shape) takes its defaults, then each slot's values, then each
 * slot's values without the column's offset, then a JSON object, an email and a 26-character
 * text; row 4 takes values where its NULLs are refused. A table whose six rows do not all go in is
 * unproven: a partial seed could hide a loss.
 */
import type { MemoryDb } from "../drivers/memory.ts"
import { type Attempt, type Column, FRESH, listedValues, SHAPES, valueFor } from "./proof-seed-values.ts"

/** A foreign key: its columns, the table they reference, and the referenced columns (none: its primary key) */
type Key = { from: string[]; table: string; to: string[] }

const ROWS = 6

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** The columns of a table's primary key and UNIQUE indexes */
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
		key: Number(row["pk"]) > 0,
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

/** The primary key columns of a parent, for a key that names none */
const primaryKeyOf = (db: MemoryDb, table: string): string[] =>
	db
		.all(`PRAGMA table_info(${quote(table)})`)
		.filter((row) => Number(row["pk"]) > 0)
		.toSorted((a, b) => Number(a["pk"]) - Number(b["pk"]))
		.map((row) => String(row["name"]))

/** What one table needs to be seeded: its name, definition, columns and keys, and the rows its parents hold (by folded name) */
type Seeding = {
	columns: Column[]
	keys: Key[]
	parents: ReadonlyMap<string, Array<Record<string, unknown>>>
	sql: string
	table: string
	/** which seed this is: a reseed (1) holds values the first seed (0) never did */
	variant: number
}

/** Row `row` of a table: each column's value, a key's columns from a parent row, or nothing where a default fills it */
function rowOf(db: MemoryDb, seeding: Seeding, at: Attempt): Map<string, unknown> | undefined {
	const { row } = at
	const values = new Map<string, unknown>()
	for (const column of seeding.columns.filter((each) => each.insertable)) {
		if (at.defaults && column.hasDefault) continue
		values.set(
			column.name,
			row === 4 && column.nullable && !at.fallback
				? null
				: valueFor(column, { ...at, variant: seeding.variant }, listedValues(seeding.sql, column.name)),
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
	/* a self-reference points at the row before it, which the table holds already */
	const self = key.table === seeding.table.toLowerCase()
	const parent = self ? db.all(`SELECT * FROM ${quote(seeding.table)}`) : (seeding.parents.get(key.table) ?? [])
	const source = self ? parent.at(-1) : parent[row % Math.max(parent.length, 1)]
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
 * What row `row` tries, in order: its own slot (row 0 with every default), then, for a row the
 * table refuses, every default with each slot, each slot plain, and each text shape
 */
function attempts(row: number): Attempt[] {
	const own = FRESH[row] as number
	const first = { defaults: row === 0, fallback: false, plain: false, row, slot: own }
	const slots = [own, ...FRESH.filter((slot) => slot !== own)]
	return [
		first,
		...slots.map((slot) => ({ defaults: true, fallback: true, plain: false, row, slot })),
		...slots.map((slot) => ({ defaults: true, fallback: true, plain: true, row, slot })),
		...SHAPES.map((_, shape) => ({ defaults: true, fallback: true, plain: true, row, shape, slot: own })),
	]
}

/* why a row cannot go in when a key it may not leave NULL has no parent row to take */
const NO_PARENT = "a key it may not leave NULL references a table comb could not seed"

/** Insert row `row` of `table` by the first attempt the table takes; or why not, its first refusal */
function seedRow(db: MemoryDb, seeding: Seeding, row: number): string | undefined {
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

/** Seed `table`: its six rows, or why a row would not go in */
function seedTable(db: MemoryDb, seeding: Seeding): string | undefined {
	for (let row = 0; row < ROWS; row++) {
		const failed = seedRow(db, seeding, row)
		if (failed !== undefined) return failed
	}
	return undefined
}

/**
 * Tables in an order that puts each parent before its children, compared by folded name as SQLite
 * resolves them; a cycle keeps the order it was given
 */
function parentsFirst(db: MemoryDb, tables: readonly string[]): string[] {
	const written = new Map(tables.map((table) => [table.toLowerCase(), table]))
	const parentsOf = new Map(tables.map((table) => [table.toLowerCase(), keysOf(db, table).map((key) => key.table)]))
	const done: string[] = []
	const visit = (key: string, path: ReadonlySet<string>) => {
		if (done.includes(key) || path.has(key)) return
		for (const parent of parentsOf.get(key) as string[])
			if (parentsOf.has(parent)) visit(parent, new Set([...path, key]))
		done.push(key)
	}
	for (const table of tables) visit(table.toLowerCase(), new Set())
	return done.map((key) => written.get(key) as string)
}

/**
 * Seed every table of `tables` (by name, each with its CREATE TABLE) in the copy; returns each
 * table comb could not seed, with why. Foreign keys are off while it seeds, and the seed is then
 * checked against them: a table whose rows break a key is unproven too.
 */
function seedTables(db: MemoryDb, tables: ReadonlyMap<string, string>, variant = 0): Map<string, string> {
	const unproven = new Map<string, string>()
	const parents = new Map<string, Array<Record<string, unknown>>>()
	db.exec("PRAGMA foreign_keys = OFF")
	for (const table of parentsFirst(db, [...tables.keys()])) {
		const seeding = {
			columns: columnsOf(db, table),
			keys: keysOf(db, table),
			parents,
			sql: tables.get(table) as string,
			table,
			variant,
		}
		const failed = seedTable(db, seeding)
		if (failed !== undefined) unproven.set(table, failed)
		/* a child's key names its parent folded, as PRAGMA foreign_key_list reports it */
		parents.set(table.toLowerCase(), db.all(`SELECT * FROM ${quote(table)}`))
	}
	for (const row of db.all("PRAGMA foreign_key_check")) {
		const table = String(row["table"]).toLowerCase()
		if (!unproven.has(table)) unproven.set(table, `its seeded rows break its key to ${String(row["parent"])}`)
	}
	return unproven
}

export { quote, seedTables }
