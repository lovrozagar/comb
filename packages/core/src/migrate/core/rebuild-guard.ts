/**
 * The guard around an Atlas SQLite table rebuild of a table other tables reference. Atlas copies
 * `T` into `new_T`, drops `T` and renames the copy. With foreign keys on (D1 always, and libsql
 * by default), the DROP TABLE first deletes every row of `T`: ON DELETE CASCADE and SET NULL then
 * change the referencing tables, RESTRICT fails, and NO ACTION fails at COMMIT, since the rows
 * come back under the new table, not the dropped one. `PRAGMA defer_foreign_keys` defers the
 * checks, never the actions.
 *
 * So comb takes the reached rows out of the way first. The closure is every table with a
 * foreign-key path to `T` over any ON DELETE action, Atlas's `new_T` included when it references
 * `T` (a self-reference points at the original). Between Atlas's copy and its drop, comb saves
 * each closure table into `_comb_keep_<t>` (rowid kept, generated columns left out), saves `T`'s
 * sqlite_sequence value, and empties the closure, children first. After the rename it refills
 * the closure, parents first, restores the sequence, and drops the keep tables. The rows, rowids,
 * keys and sequences end as they were, at twice the closure's writes.
 *
 * A trigger on a reached table fires on both the emptying and the refill. That nets out only for
 * an FTS trigger, which deletes and re-adds the same entry, so any other trigger there is refused.
 */
import type { ExtractedSchema } from "../types.ts"
import type { FtsState } from "./fts-migration.ts"
import { extractSchema } from "./schema.ts"
import { codeOf, lastPart, QNAME } from "./sql-code.ts"
import { normalizeSql, splitSqlStatements } from "./sql-scan.ts"

const KEEP = "_comb_keep_"

const quote = (name: string): string => `\`${name.replaceAll("`", "``")}\``
const keep = (table: string): string => quote(`${KEEP}${table}`)
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

/** An Atlas rebuild: `table` copied into `temp`, dropped, and `temp` renamed onto it */
type Rebuild = { table: string; temp: string }

/** A rebuild in a file: the indexes of its copy, its drop and its rename among the file's statements */
type Located = Rebuild & { copy: number; drop: number; rename: number }

// per-process-constant: the three statements of an Atlas rebuild, composed once
const COPY = /* @__PURE__ */ new RegExp(`^INSERT INTO (${QNAME}) \\([^)]*\\) SELECT\\b.* FROM (${QNAME})$`, "i")
// per-process-constant: see above
const DROP = /* @__PURE__ */ new RegExp(`^DROP TABLE (?:IF EXISTS )?(${QNAME})$`, "i")
// per-process-constant: see above
const RENAME = /* @__PURE__ */ new RegExp(`^ALTER TABLE (${QNAME}) RENAME TO (${QNAME})$`, "i")

/** The rebuilds among a file's statement codes: a copy of `T` into `temp`, a drop of `T`, `temp` renamed to `T` */
function locateRebuilds(codes: readonly string[]): Located[] {
	const copies = new Map<string, { copy: number; drop?: number; table: string }>()
	const out: Located[] = []
	for (const [i, code] of codes.entries()) {
		const [, into, from] = COPY.exec(code) ?? []
		if (into !== undefined && from !== undefined) copies.set(lastPart(into), { copy: i, table: lastPart(from) })
		const dropped = DROP.exec(code)?.[1]
		const open = [...copies.values()].find((c) => c.table === lastPart(dropped ?? "") && c.drop === undefined)
		if (dropped !== undefined && open !== undefined) open.drop = i
		const [, temp, to] = RENAME.exec(code) ?? []
		const copy = temp === undefined ? undefined : copies.get(lastPart(temp))
		if (copy?.drop !== undefined && copy.table === lastPart(to as string)) {
			out.push({ copy: copy.copy, drop: copy.drop, rename: i, table: copy.table, temp: lastPart(temp as string) })
			copies.delete(lastPart(temp as string))
		}
	}
	return out
}

/** The schema at a rebuild's copy: `before`, then the file's statements ahead of it */
const schemaAt = (statements: readonly string[], { copy }: Located, before: ExtractedSchema): ExtractedSchema =>
	extractSchema(statements.slice(0, copy).join(";\n"), before)

/** The statements a guard puts before Atlas's DROP TABLE and after its RENAME */
type Guard = { after: string[]; before: string[] }

/** The tables a drop of `table` reaches, breadth first: each with a foreign-key path to it */
function reached(table: string, schema: ExtractedSchema): string[] {
	const out: string[] = []
	const seen = new Set([table])
	const queue = [table]
	for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
		for (const key of schema.foreignKeys) {
			if (key.parent !== parent || seen.has(key.table)) continue
			seen.add(key.table)
			out.push(key.table)
			queue.push(key.table)
		}
	}
	return out
}

/** The columns an INSERT may write: every column but the generated ones */
function stored(table: string, schema: ExtractedSchema): string[] {
	const generated = schema.tableInfo.get(table)?.generatedColumns ?? []
	return (schema.tables.get(table) ?? []).filter((column) => !generated.includes(column))
}

/** A closure table's columns as the keep table holds them: its rowid first, unless it has none */
function kept(table: string, schema: ExtractedSchema): { columns: string[]; rowid: boolean } {
	return { columns: stored(table, schema).map(quote), rowid: schema.tableInfo.get(table)?.withoutRowid !== true }
}

/**
 * The guard a rebuild needs, given the schema at Atlas's copy: undefined when no table
 * references the rebuilt one, so its drop reaches nothing
 */
function guardOf({ table, temp }: Rebuild, schema: ExtractedSchema): Guard | undefined {
	const closure = reached(table, schema)
	if (closure.length === 0) return undefined
	const sequence = schema.tableInfo.get(table)?.autoincrement === true
	const save = (t: string) => {
		const { columns, rowid } = kept(t, schema)
		return `CREATE TABLE ${keep(t)} AS SELECT ${[...(rowid ? ["rowid AS `_comb_rowid`"] : []), ...columns].join(", ")} FROM ${quote(t)}`
	}
	const refill = (t: string) => {
		const { columns, rowid } = kept(t, schema)
		const into = [...(rowid ? ["rowid"] : []), ...columns].join(", ")
		const from = [...(rowid ? ["`_comb_rowid`"] : []), ...columns].join(", ")
		return `INSERT INTO ${quote(t === temp ? table : t)} (${into}) SELECT ${from} FROM ${keep(t)}`
	}
	const name = literal(table)
	const before = [
		...closure.map(save),
		...(sequence ? [`CREATE TABLE ${keep(table)} AS SELECT seq FROM sqlite_sequence WHERE name = ${name}`] : []),
		...closure.toReversed().map((t) => `DELETE FROM ${quote(t)}`),
	]
	const after = [
		...[...closure.filter((t) => t === temp), ...closure.filter((t) => t !== temp)].map(refill),
		...(sequence
			? [
					`UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM ${keep(table)}), 0)) WHERE name = ${name}`,
					`INSERT INTO sqlite_sequence (name, seq) SELECT ${name}, seq FROM ${keep(table)} WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ${name})`,
				]
			: []),
		...[...closure, ...(sequence ? [table] : [])].map((t) => `DROP TABLE ${keep(t)}`),
	]
	return { after, before }
}

/** The trigger names comb's FTS groups own in `fts` */
const ftsTriggers = (fts: FtsState | undefined): Set<string> =>
	new Set([...(fts ?? [])].filter(([, object]) => object.kind === "trigger").map(([name]) => name))

/**
 * Refuses a rebuild the guard cannot keep whole, naming what stops it: a table already using the
 * guard's prefix, a reached table whose columns the history does not show, or a trigger other
 * than an FTS one on the rebuilt table or a reached one
 */
function refuseUnguardable({ table }: Rebuild, schema: ExtractedSchema, fts: FtsState | undefined): void {
	const reserved = [...schema.tables.keys()].find((name) => name.startsWith(KEEP))
	if (reserved !== undefined) {
		throw new Error(
			`the schema has a table named ${reserved}; comb's guard around a table rebuild reserves the ${KEEP} prefix`,
		)
	}
	const closure = reached(table, schema)
	const unknown = closure.find((t) => !schema.tables.has(t) || !schema.tableInfo.has(t))
	if (unknown !== undefined) {
		throw new Error(`a rebuild of ${table} reaches ${unknown}, whose columns the migrations do not show`)
	}
	const owned = ftsTriggers(fts)
	const tables = new Set([table, ...closure])
	const trigger = schema.triggers.find((t) => tables.has(t.table) && !owned.has(t.name))
	if (trigger !== undefined) {
		throw new Error(
			`a rebuild of ${table} empties and refills ${trigger.table}, which fires its trigger ${trigger.name}; drop the trigger first, or change ${table} by hand`,
		)
	}
}

/**
 * `sql` with each rebuild of a referenced table guarded, read against `before`, the schema the
 * earlier migrations leave; FTS triggers in `fts` are the ones the guard may fire. Refuses a
 * rebuild it cannot guard. Without `before`, or with no such rebuild, `sql` comes back unchanged.
 */
function guardRebuilds(sql: string, before: ExtractedSchema | undefined, fts?: FtsState): string {
	const statements = splitSqlStatements(sql)
	const rebuilds = before === undefined ? [] : locateRebuilds(statements.map((stmt) => codeOf(stmt, "sqlite")))
	/* by statement index: what goes before a rebuild's drop, and after its rename */
	const ahead = new Map<number, string[]>()
	const behind = new Map<number, string[]>()
	for (const rebuild of rebuilds) {
		const schema = schemaAt(statements, rebuild, before as ExtractedSchema)
		const guard = guardOf(rebuild, schema)
		if (guard === undefined) continue
		refuseUnguardable(rebuild, schema, fts)
		ahead.set(rebuild.drop, guard.before)
		behind.set(rebuild.rename, guard.after)
	}
	if (ahead.size === 0) return sql
	const out = statements.flatMap((stmt, i) => [...(ahead.get(i) ?? []), stmt, ...(behind.get(i) ?? [])])
	return `${out.join(";\n")};\n`
}

/**
 * The statements of a file that are the guards comb wrote, each exactly as comb writes it, and
 * the rebuilt tables of referenced rebuilds left unguarded, with the tables their drop reaches
 */
function readGuards(
	statements: readonly string[],
	codes: readonly string[],
	before: ExtractedSchema | undefined,
): { guarded: Set<number>; unguarded: Map<string, string[]> } {
	const guarded = new Set<number>()
	const unguarded = new Map<string, string[]>()
	const same = (at: number, expected: readonly string[]) =>
		expected.every((stmt, k) => normalizeSql(statements[at + k] ?? "") === normalizeSql(stmt))
	for (const rebuild of before === undefined ? [] : locateRebuilds(codes)) {
		const schema = schemaAt(statements, rebuild, before as ExtractedSchema)
		const guard = guardOf(rebuild, schema)
		if (guard === undefined) continue
		const start = rebuild.drop - guard.before.length
		const whole =
			start > rebuild.copy &&
			rebuild.rename === rebuild.drop + 1 &&
			same(start, guard.before) &&
			same(rebuild.rename + 1, guard.after)
		if (!whole) {
			unguarded.set(rebuild.table, reached(rebuild.table, schema))
			continue
		}
		for (let i = start; i < rebuild.drop; i++) guarded.add(i)
		for (let i = 1; i <= guard.after.length; i++) guarded.add(rebuild.rename + i)
	}
	return { guarded, unguarded }
}

export { guardRebuilds, readGuards }
