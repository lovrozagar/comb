/**
 * The seed's foreign keys (SD1 of r22, 8.4): each table's keys as SQLite reads them, the tables grouped by cycles of
 * keys with each group's parents first, and a cycle's keys closed once the tables they point at are seeded
 */
import type { LocalDb } from "../drivers/local-db.ts"
import type { Column } from "./proof-seed-values.ts"
import { asciiFold } from "./sql-code.ts"

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** A foreign key: its columns, the table they reference, and the referenced columns (none: its primary key) */
type Key = { from: string[]; table: string; to: string[] }

/** A table's foreign keys, each column group of PRAGMA foreign_key_list together */
function keysOf(db: LocalDb, table: string): Key[] {
	const keys = new Map<number, Key>()
	for (const row of db.all(`PRAGMA foreign_key_list(${quote(table)})`)) {
		const id = Number(row["id"])
		const key = keys.get(id) ?? { from: [], table: asciiFold(String(row["table"])), to: [] }
		key.from.push(String(row["from"]))
		if (row["to"] !== null) key.to.push(String(row["to"]))
		keys.set(id, key)
	}
	return [...keys.values()]
}

/** The primary key columns of a parent, for a key that names none */
const primaryKeyOf = (db: LocalDb, table: string): string[] =>
	db
		.all(`PRAGMA table_info(${quote(table)})`)
		.filter((row) => Number(row["pk"]) > 0)
		.toSorted((a, b) => Number(a["pk"]) - Number(b["pk"]))
		.map((row) => String(row["name"]))

/** Whether every column of `key` may be NULL, so a row may leave it unset */
const mayBeNull = (columns: readonly Column[], key: Key): boolean =>
	key.from.every((name) => columns.find((column) => column.name === name)?.nullable === true)

/* why a row cannot go in when a key it may not leave NULL has no parent row to take */
const NO_PARENT = "a key it may not leave NULL references a table comb could not seed"

/** What closing a table's keys reads: the table, its columns and keys, its cycle's later tables, and their rows */
type Closing = {
	columns: readonly Column[]
	keys: readonly Key[]
	later: ReadonlySet<string>
	parents: ReadonlyMap<string, Array<Record<string, unknown>>>
	table: string
}

/**
 * Tables grouped by cycles of foreign keys, each group's parents' groups before it (Tarjan's strongly connected
 * components, compared by folded name as SQLite resolves them): a table in no cycle is a group of its own, and a
 * cycle's tables keep the order they were given
 */
function keyGroups(db: LocalDb, tables: readonly string[]): string[][] {
	const written = new Map(tables.map((table) => [asciiFold(table), table]))
	const parentsOf = new Map(
		tables.map((table) => [
			asciiFold(table),
			keysOf(db, table)
				.map((key) => key.table)
				.filter((p) => written.has(p)),
		]),
	)
	const index = new Map<string, number>()
	const low = new Map<string, number>()
	const stack: string[] = []
	const groups: string[][] = []
	const visit = (key: string) => {
		index.set(key, index.size)
		low.set(key, index.size - 1)
		stack.push(key)
		for (const parent of parentsOf.get(key) as string[]) {
			if (!index.has(parent)) visit(parent)
			if (stack.includes(parent)) low.set(key, Math.min(low.get(key) as number, low.get(parent) as number))
		}
		if (low.get(key) !== index.get(key)) return
		const group = stack.splice(stack.indexOf(key))
		groups.push(tables.filter((table) => group.includes(asciiFold(table))))
	}
	for (const table of tables) if (!index.has(asciiFold(table))) visit(asciiFold(table))
	return groups
}

/** The columns that name one row of `table`: its primary key, or its rowid where it declares none */
function rowIdOf(db: LocalDb, table: string): string[] {
	const key = primaryKeyOf(db, table)
	return key.length > 0 ? key : ["rowid"]
}

/** Sets each row's key of `seeding` into its cycle's later tables, which may not be NULL, to that table's rows */
function closeKeys(db: LocalDb, seeding: Closing): void {
	const id = rowIdOf(db, seeding.table)
	const rows = db.all(`SELECT ${id.map(quote).join(", ")} FROM ${quote(seeding.table)}`)
	for (const key of seeding.keys.filter((each) => seeding.later.has(each.table) && !mayBeNull(seeding.columns, each))) {
		const parent = seeding.parents.get(key.table) as Array<Record<string, unknown>>
		if (parent.length === 0 && rows.length > 0) throw new Error(NO_PARENT)
		const to = key.to.length > 0 ? key.to : primaryKeyOf(db, key.table)
		const set = key.from.map((name) => `${quote(name)} = ?`).join(", ")
		const where = id.map((name) => `${quote(name)} IS ?`).join(" AND ")
		for (const [i, row] of rows.entries()) {
			const source = parent[i % parent.length] as Record<string, unknown>
			db.run(`UPDATE ${quote(seeding.table)} SET ${set} WHERE ${where}`, [
				...to.map((name) => source[name]),
				...id.map((name) => row[name]),
			])
		}
	}
}

export { closeKeys, type Key, keyGroups, keysOf, mayBeNull, NO_PARENT, primaryKeyOf, quote }
