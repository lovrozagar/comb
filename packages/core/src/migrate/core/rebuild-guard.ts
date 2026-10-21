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
 * each closure table into `_comb_keep_<t>` (generated columns left out), saves `T`'s
 * sqlite_sequence value, and empties the closure, each table after the tables that reference it.
 * The guard opens with `PRAGMA defer_foreign_keys = on`, whatever the file holds, so the refill's
 * keys are checked at commit: a closure that is a reference cycle has no order that satisfies
 * them one row at a time. After the rename it refills the closure in the opposite order, parents
 * first, restores the sequence, and drops the keep tables. The rows, keys and sequences end as
 * they were, at twice the closure's writes.
 *
 * The rowids end as they were too. A table whose key is its rowid keeps them with its key; any
 * other rowid table carries them apart, in the keep table and, for `T`, in Atlas's copy, which
 * comb rewrites to `INSERT INTO new_T (rowid, …) SELECT rowid, …`. D1 caps a SELECT at 100 result
 * columns, so a table carries its rowid beside at most 99 columns; at 100 its rows are kept whole
 * under new rowids, and the classification names it.
 *
 * A trigger on a reached table fires on both the emptying and the refill. That nets out only for
 * an FTS trigger, which deletes and re-adds the same entry, so any other trigger there is refused.
 */
import type { ExtractedSchema } from "../types.ts"
import type { FtsState } from "./fts-migration.ts"
import { extractSchema } from "./schema.ts"
import { readCopy } from "./rebuild-copy.ts"
import { kept, quote, type Rebuild, renumberedBy, rowidCopy } from "./rebuild-rowids.ts"
import { codeOf, lastPart, QNAME } from "./sql-code.ts"
import { normalizeSql, splitSqlStatements } from "./sql-scan.ts"

const KEEP = "_comb_keep_"

const keep = (table: string): string => quote(`${KEEP}${table}`)
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

/** A rebuild in a file: the indexes of its copy, its drop and its rename among the file's statements */
type Located = Rebuild & { copy: number; drop: number; rename: number }

// per-process-constant: the drop and the rename of an Atlas rebuild, composed once; its copy is readCopy's
const DROP = /* @__PURE__ */ new RegExp(`^DROP TABLE (?:IF EXISTS )?(${QNAME})$`, "i")
// per-process-constant: see above
const RENAME = /* @__PURE__ */ new RegExp(`^ALTER TABLE (${QNAME}) RENAME TO (${QNAME})$`, "i")

/** The rebuilds among a file's statements and their codes: a copy of `T` into `temp`, a drop of `T`, `temp` renamed to `T` */
function locateRebuilds(statements: readonly string[], codes: readonly string[]): Located[] {
	const copies = new Map<string, { copy: number; drop?: number; table: string }>()
	const out: Located[] = []
	for (const [i, code] of codes.entries()) {
		const read = /^INSERT INTO\b/i.test(code) ? readCopy(statements[i] as string, () => "") : undefined
		if (read !== undefined) copies.set(read.into, { copy: i, table: read.from })
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

/**
 * The closure in the order to empty it: each table after every table of the closure that
 * references it, so no RESTRICT or NO ACTION key stops a delete; in a cycle, which has no such
 * order, the breadth-first order reversed
 */
function childrenFirst(closure: readonly string[], schema: ExtractedSchema): string[] {
	const members = new Set(closure)
	const childrenOf = (table: string) =>
		schema.foreignKeys.filter((key) => key.parent === table && key.table !== table && members.has(key.table))
	const left = closure.toReversed()
	const out: string[] = []
	while (left.length > 0) {
		const ready = left.findIndex((table) => childrenOf(table).every((key) => out.includes(key.table)))
		out.push(...left.splice(Math.max(ready, 0), 1))
	}
	return out
}

/**
 * The guard a rebuild needs, given the schema at Atlas's copy: undefined when no table
 * references the rebuilt one, so its drop reaches nothing
 */
function guardOf({ table, temp }: Rebuild, schema: ExtractedSchema, legacy = false): Guard | undefined {
	const closure = reached(table, schema)
	if (closure.length === 0) return undefined
	const sequence = schema.tableInfo.get(table)?.autoincrement === true
	const save = (t: string) => {
		const { columns, rowid } = kept(t, schema, legacy)
		return `CREATE TABLE ${keep(t)} AS SELECT ${[...(rowid ? ["rowid AS `_comb_rowid`"] : []), ...columns].join(", ")} FROM ${quote(t)}`
	}
	const refill = (t: string) => {
		const { columns, rowid } = kept(t, schema, legacy)
		const into = [...(rowid ? ["rowid"] : []), ...columns].join(", ")
		const from = [...(rowid ? ["`_comb_rowid`"] : []), ...columns].join(", ")
		return `INSERT INTO ${quote(t === temp ? table : t)} (${into}) SELECT ${from} FROM ${keep(t)}`
	}
	const name = literal(table)
	const emptying = childrenFirst(closure, schema)
	const before = [
		/* the refill's keys checked at commit, whatever order a cycle leaves; the file may not defer them */
		...(legacy ? [] : ["PRAGMA defer_foreign_keys = on"]),
		...closure.map(save),
		...(sequence ? [`CREATE TABLE ${keep(table)} AS SELECT seq FROM sqlite_sequence WHERE name = ${name}`] : []),
		...emptying.map((t) => `DELETE FROM ${quote(t)}`),
	]
	const after = [
		...[...closure.filter((t) => t === temp), ...emptying.toReversed().filter((t) => t !== temp)].map(refill),
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
	const codes = statements.map((stmt) => codeOf(stmt, "sqlite"))
	const rebuilds = before === undefined ? [] : locateRebuilds(statements, codes)
	/* by statement index: what goes before a rebuild's drop, after its rename, and in place of its copy */
	const ahead = new Map<number, string[]>()
	const behind = new Map<number, string[]>()
	const copies = new Map<number, string>()
	for (const rebuild of rebuilds) {
		const schema = schemaAt(statements, rebuild, before as ExtractedSchema)
		const copy = rowidCopy(
			{ code: codes[rebuild.copy] as string, stmt: statements[rebuild.copy] as string },
			rebuild,
			schema,
		)
		if (copy !== undefined) copies.set(rebuild.copy, copy)
		const guard = guardOf(rebuild, schema)
		if (guard === undefined) continue
		refuseUnguardable(rebuild, schema, fts)
		ahead.set(rebuild.drop, guard.before)
		behind.set(rebuild.rename, guard.after)
	}
	if (ahead.size === 0 && copies.size === 0) return sql
	const out = statements.flatMap((stmt, i) => [
		...(ahead.get(i) ?? []),
		copies.get(i) ?? stmt,
		...(behind.get(i) ?? []),
	])
	return `${out.join(";\n")};\n`
}

/** A file with no guards: the guards a dialect without rebuilds reads */
const noGuards = (): Guards => ({ guarded: new Set(), kept: new Map(), renumbered: new Map(), unguarded: new Map() })

/** What a file's guards come to: see readGuards */
type Guards = {
	guarded: Set<number>
	kept: Map<string, string[]>
	renumbered: Map<string, string[]>
	unguarded: Map<string, string[]>
}

/**
 * The statements of a file that are the guards comb wrote, each exactly as comb writes it (or as
 * comb 0.8 wrote it), the tables each guarded rebuild keeps the rows of, the tables each rebuild
 * leaves under new rowids, and the rebuilt tables of referenced rebuilds left unguarded, with the
 * tables their drop reaches
 */
function readGuards(
	statements: readonly string[],
	codes: readonly string[],
	before: ExtractedSchema | undefined,
): Guards {
	const out = noGuards()
	const same = (at: number, expected: readonly string[]) =>
		expected.every((stmt, k) => normalizeSql(statements[at + k] ?? "") === normalizeSql(stmt))
	for (const rebuild of before === undefined ? [] : locateRebuilds(statements, codes)) {
		const schema = schemaAt(statements, rebuild, before as ExtractedSchema)
		const closure = reached(rebuild.table, schema)
		const copy = codes[rebuild.copy] as string
		const whole = (guard: Guard) => {
			const start = rebuild.drop - guard.before.length
			return (
				start > rebuild.copy &&
				rebuild.rename === rebuild.drop + 1 &&
				same(start, guard.before) &&
				same(rebuild.rename + 1, guard.after)
			)
		}
		const current = guardOf(rebuild, schema)
		if (current === undefined) {
			out.renumbered.set(rebuild.table, renumberedBy(rebuild, schema, { closure: [], code: copy }))
			continue
		}
		const guard = [current, guardOf(rebuild, schema, true) as Guard].find(whole)
		if (guard === undefined) {
			out.unguarded.set(rebuild.table, closure)
			continue
		}
		out.kept.set(
			rebuild.table,
			closure.filter((t) => t !== rebuild.temp),
		)
		out.renumbered.set(
			rebuild.table,
			renumberedBy(rebuild, schema, { closure: guard === current ? closure : [], code: copy }),
		)
		for (let i = rebuild.drop - guard.before.length; i < rebuild.drop; i++) out.guarded.add(i)
		for (let i = 1; i <= guard.after.length; i++) out.guarded.add(rebuild.rename + i)
	}
	return out
}

/** Each referenced table a file rebuilds, with the tables its drop reaches by the history */
function guardedClosures(
	sql: string,
	before: ExtractedSchema,
): Array<{ closure: string[]; table: string; temp: string }> {
	const statements = splitSqlStatements(sql)
	return locateRebuilds(
		statements,
		statements.map((stmt) => codeOf(stmt, "sqlite")),
	).flatMap((rebuild) => {
		const closure = reached(rebuild.table, schemaAt(statements, rebuild, before))
		return closure.length === 0 ? [] : [{ closure, table: rebuild.table, temp: rebuild.temp }]
	})
}

export { guardedClosures, guardRebuilds, noGuards, readGuards }
