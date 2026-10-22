/**
 * The proof run's comparison (proof-run.ts): each table that was there before a file, before and
 * after it, as a multiset of whole rows over the columns it had. A lost row, a lost column or a
 * changed value is unsafe, and the reason names the table and column; a NULL that lands as the
 * column's new DEFAULT, in a column the file made NOT NULL, is cautious.
 */
import type { MemoryDb } from "../drivers/memory.ts"

/** One table as the proof compares it: its stored columns, whether each may hold NULL, its default, and its rows */
type Shape = { columns: string[]; defaults: Map<string, string | null>; nullable: Set<string>; rows: string[][] }

/** What a file did to the tables before it: the proof's findings without what it could not prove */
type Findings = { cautious: string[]; unsafe: string[] }

/** Each value of `keys`, with how many times it occurs */
function counts(keys: readonly string[]): Map<string, number> {
	const out = new Map<string, number>()
	for (const key of keys) out.set(key, (out.get(key) ?? 0) + 1)
	return out
}

/** How many of `before` are not in `after`, each counted as often as it occurs */
function missing(before: readonly string[], after: readonly string[]): number {
	const held = counts(after)
	return [...counts(before)].reduce((sum, [key, n]) => sum + Math.max(0, n - (held.get(key) ?? 0)), 0)
}

/**
 * The one allowance: each column the file made NOT NULL with a DEFAULT, which was nullable, with
 * that default as SQLite quotes it. Atlas's "make NOT NULL with a default" rebuild fills its NULLs so.
 */
function allowedDefaults(db: MemoryDb, { now, was }: { now: Shape; was: Shape }): Map<string, string> {
	const out = new Map<string, string>()
	for (const column of was.columns) {
		const fresh = now.defaults.get(column)
		if (!was.nullable.has(column) || now.nullable.has(column) || fresh === null || fresh === undefined) continue
		out.set(column, String(db.all(`SELECT quote(${fresh}) AS v`)[0]?.["v"]))
	}
	return out
}

/** Each row of `shape` as one key over `columns`, a NULL in a column of `fill` read as its default */
function rowKeys(shape: Shape, columns: readonly string[], fill: ReadonlyMap<string, string> = new Map()): string[] {
	const at = columns.map((column) => shape.columns.indexOf(column))
	return shape.rows.map((row) =>
		JSON.stringify(
			columns.map((column, i) => {
				const value = row[at[i] as number] as string
				return value === "NULL" ? (fill.get(column) ?? value) : value
			}),
		),
	)
}

/**
 * The columns whose values a file changed: those whose own values differ, else those whose
 * leaving out makes the rows match (a value moved between rows keeps the column's values)
 */
function changedColumns(was: Shape, now: Shape, fill: ReadonlyMap<string, string>): string[] {
	const columns = was.columns.filter((each) => now.columns.includes(each))
	const differs = (picked: readonly string[]) => missing(rowKeys(was, picked, fill), rowKeys(now, picked)) > 0
	const own = columns.filter((column) => differs([column]))
	return own.length > 0 ? own : columns.filter((column) => !differs(columns.filter((each) => each !== column)))
}

/**
 * What a file did to one table that was there before it, compared as a multiset of whole rows over
 * the columns it had: so a value copied, swapped or moved between rows shows, not only one lost
 */
function compareTable(db: MemoryDb, table: string, { now, was }: { now: Shape; was: Shape }): Findings {
	const out: Findings = { cautious: [], unsafe: [] }
	for (const column of was.columns.filter((each) => !now.columns.includes(each)))
		out.unsafe.push(`loses ${table}.${column}`)
	/* a lost row changes every column's values: the loss alone is the finding */
	if (now.rows.length < was.rows.length) {
		out.unsafe.push(`loses ${was.rows.length - now.rows.length} of the ${was.rows.length} rows of ${table}`)
		return out
	}
	const columns = was.columns.filter((each) => now.columns.includes(each))
	const fill = allowedDefaults(db, { now, was })
	if (missing(rowKeys(was, columns, fill), rowKeys(now, columns)) === 0) {
		const nulls = [...fill.keys()].filter((column) =>
			was.rows.some((row) => row[was.columns.indexOf(column)] === "NULL"),
		)
		for (const column of nulls) out.cautious.push(`fills ${table}.${column}'s NULLs with its default`)
		return out
	}
	const changed = changedColumns(was, now, fill)
	if (changed.length === 0) out.unsafe.push(`changes rows of ${table}`)
	for (const column of changed) out.unsafe.push(`changes values of ${table}.${column}`)
	return out
}

/** What a file did to each table that was there before it */
function compare(db: MemoryDb, before: ReadonlyMap<string, Shape>, after: ReadonlyMap<string, Shape>): Findings {
	const out: Findings = { cautious: [], unsafe: [] }
	for (const [table, was] of before) {
		const now = after.get(table)
		if (now === undefined) out.unsafe.push(`loses every row of ${table}`)
		else {
			const found = compareTable(db, table, { now, was })
			out.cautious.push(...found.cautious)
			out.unsafe.push(...found.unsafe)
		}
	}
	return out
}

export { compare, type Findings, type Shape }
