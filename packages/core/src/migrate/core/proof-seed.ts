/**
 * The proof run's seed: rows for each table of an in-memory copy of a database, chosen so a change
 * to any value shows. Row 0 takes every default; rows 1 to 3 hold discriminating values (text that
 * looks numeric, mixed case, non-ASCII, signed and large numbers), each column's three distinct,
 * and no two columns sharing a value in a row, so a copy or a swap between columns shows. Then a
 * pair of rows per bit of the nullable columns' numbering (at least one pair): numbering the
 * nullable columns 0 to n-1, the pair's first row is NULL where the column's bit is 1 and its
 * second where it is 0 (a reseed swaps them), so any two nullable columns have a row where one is
 * NULL and the other holds a value, either way round, and a fill between them shows. Text holds
 * outer whitespace, and an empty string in row 0's columns without a default (the one value those
 * columns share). A column a pending file reads as JSON holds JSON, its column's and its seed's
 * own. No value repeats down a column, and an INTEGER primary
 * key starts past 2^40, an id no migration writes: a file's new unique index or explicit id meets
 * no seeded row. A column checked `IN (...)` takes its listed values, and a key column its parent's
 * keys, parents seeded first (a self-reference, the row before it). A row the table refuses (a
 * CHECK across columns, a range, a shape) takes its defaults, then each slot's values, then each
 * slot's values without the column's offset, then each affinity's shapes (proof-seed-values.ts);
 * a NULL row takes values where its NULLs are refused. A table whose rows do not all go in is
 * unproven: a partial seed could hide a loss.
 */
import type { MemoryDb } from "../drivers/memory.ts"
import { affinityOf } from "./sqlite-affinity.ts"
import {
	type Attempt,
	type Column,
	JSON_SHAPE,
	listedValues,
	shapeCount,
	slotOf,
	valueFor,
} from "./proof-seed-values.ts"

/** A foreign key: its columns, the table they reference, and the referenced columns (none: its primary key) */
type Key = { from: string[]; table: string; to: string[] }

/** How many rows a table of `columns` takes: four, and a pair per bit of its nullable columns' numbering */
function rowCount(columns: readonly Column[]): number {
	const nullable = columns.filter((column) => column.nullOrdinal >= 0).length
	return 4 + 2 * Math.max(1, Math.ceil(Math.log2(Math.max(nullable, 1))))
}

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
	let ordinal = 0
	return db.all(`PRAGMA table_xinfo(${quote(table)})`).map((row, index) => {
		const nullable = row["notnull"] === 0 && row["pk"] === 0
		const insertable = row["hidden"] === 0
		return {
			hasDefault: row["dflt_value"] !== null,
			index,
			insertable,
			name: String(row["name"]),
			nullable,
			nullOrdinal: nullable && insertable ? ordinal++ : -1,
			key: Number(row["pk"]) > 0,
			type: String(row["type"]),
			unique: Number(row["pk"]) > 0 || unique.has(String(row["name"])),
		}
	})
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
	/** the columns, by lower-case name, a pending file reads with a `json_*` function */
	json: ReadonlySet<string>
	sql: string
	table: string
	/** which seed this is: a reseed (1) holds values the first seed (0) never did */
	variant: number
}

/** Whether row `row` leaves the column at `index` NULL: row 4 the even positions, row 5 the odd, swapped by a reseed */
/**
 * Whether row `row` leaves the nullable column numbered `ordinal` NULL: rows from 4 come in pairs,
 * one per bit of the numbering; the first of a pair is NULL where the bit is 1, the second where it
 * is 0, and a reseed swaps them
 */
function nullAt(row: number, ordinal: number, variant: number): boolean {
	if (row < 4 || ordinal < 0) return false
	const bit = (ordinal >> Math.floor((row - 4) / 2)) & 1
	const first = (row - 4) % 2 === 0
	return bit === (first === (variant % 2 === 0) ? 1 : 0)
}

/** A column's value in row `row`: JSON where a pending file reads it so, else the attempt's */
function valueOf(seeding: Seeding, column: Column, at: Attempt): unknown {
	if (!at.fallback && seeding.json.has(column.name.toLowerCase()) && affinityOf(column.type) === "TEXT")
		return JSON_SHAPE(at.row, column.index, seeding.variant)
	return valueFor(column, { ...at, variant: seeding.variant }, listedValues(seeding.sql, column.name))
}

/** Row `row` of a table: each column's value, a key's columns from a parent row, or nothing where a default fills it */
function rowOf(db: MemoryDb, seeding: Seeding, at: Attempt): Map<string, unknown> | undefined {
	const { row } = at
	const values = new Map<string, unknown>()
	for (const column of seeding.columns.filter((each) => each.insertable)) {
		if (at.defaults && column.hasDefault) continue
		const empty = !at.fallback && nullAt(row, column.nullOrdinal, seeding.variant)
		values.set(column.name, empty ? null : valueOf(seeding, column, at))
	}
	for (const key of seeding.keys) if (!keyValues(db, seeding, { key, row, values })) return undefined
	return values
}

/**
 * A key's columns in row `row`, from a parent row (NULL where the row leaves its first column NULL
 * and every column may be, or when the parent has no rows); false when the parent has none and
 * the key may not be NULL
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
	const columns = key.from.map((name) => seeding.columns.find((c) => c.name === name))
	const nullable = columns.every((column) => column?.nullable === true)
	if (source === undefined && !nullable) return false
	const to = key.to.length > 0 ? key.to : primaryKeyOf(db, key.table)
	const empty = nullable && nullAt(row, (columns[0] as Column).nullOrdinal, seeding.variant)
	for (const [i, name] of key.from.entries())
		values.set(name, source === undefined || empty ? null : source[to[i] as string])
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
 * table refuses, every default with each slot, each slot plain, and each shape
 */
function attempts(row: number): Attempt[] {
	const own = slotOf(row)
	const first = { defaults: row === 0, fallback: false, plain: false, row, slot: own }
	const slots = [own, ...[0, 1, 2, 3, 4, 5].filter((slot) => slot !== own)]
	return [
		first,
		...slots.map((slot) => ({ defaults: true, fallback: true, plain: false, row, slot })),
		...slots.map((slot) => ({ defaults: true, fallback: true, plain: true, row, slot })),
		...Array.from({ length: shapeCount() }, (_, shape) => ({
			defaults: true,
			fallback: true,
			plain: true,
			row,
			shape,
			slot: own,
		})),
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

/** Seed `table`: its rows, or why a row would not go in */
function seedTable(db: MemoryDb, seeding: Seeding): string | undefined {
	for (let row = 0; row < rowCount(seeding.columns); row++) {
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
 * table comb could not seed, by its folded name, with why. Foreign keys are off while it seeds, and the seed is then
 * checked against them: a table whose rows break a key is unproven too.
 */
function seedTables(
	db: MemoryDb,
	tables: ReadonlyMap<string, string>,
	{ json, variant }: { json: ReadonlySet<string>; variant: number },
): Map<string, string> {
	const unproven = new Map<string, string>()
	const parents = new Map<string, Array<Record<string, unknown>>>()
	db.exec("PRAGMA foreign_keys = OFF")
	for (const table of parentsFirst(db, [...tables.keys()])) {
		const seeding = {
			columns: columnsOf(db, table),
			json,
			keys: keysOf(db, table),
			parents,
			sql: tables.get(table) as string,
			table,
			variant,
		}
		const failed = seedTable(db, seeding)
		/* keyed folded, as PRAGMA foreign_key_check and a child's key name the table */
		if (failed !== undefined) unproven.set(table.toLowerCase(), failed)
		parents.set(table.toLowerCase(), db.all(`SELECT * FROM ${quote(table)}`))
	}
	for (const row of db.all("PRAGMA foreign_key_check")) {
		const table = String(row["table"]).toLowerCase()
		if (!unproven.has(table)) unproven.set(table, `its seeded rows break its key to ${String(row["parent"])}`)
	}
	return unproven
}

export { quote, seedTables }
