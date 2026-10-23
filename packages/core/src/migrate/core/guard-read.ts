/**
 * comb's guards around a rebuild, read back at check time (rebuild-guard.ts writes them at diff
 * time): which statements of a file are a guard exactly as comb writes it, the rows each keeps,
 * the tables each leaves under new rowids, a referenced rebuild left unguarded, and a guard that
 * would fire a trigger a later file put on a table it empties.
 */
import type { ExtractedSchema } from "../types.ts"
import { renumberedBy } from "./rebuild-rowids.ts"
import { firedBy, firesMessage, type Guard, guardOf, locateRebuilds, reached, schemaAt } from "./rebuild-guard.ts"
import { normalizeSql } from "./sql-scan.ts"

/** A file with no guards: the guards a dialect without rebuilds reads */
const noGuards = (): Guards => ({
	fired: new Map(),
	guarded: new Set(),
	kept: new Map(),
	renumbered: new Map(),
	unguarded: new Map(),
})

/** What a file's guards come to: see readGuards */
type Guards = {
	/** guarded rebuilds whose guard fires a trigger, other than an FTS sync one, with why */
	fired: Map<string, string>
	guarded: Set<number>
	kept: Map<string, string[]>
	renumbered: Map<string, string[]>
	unguarded: Map<string, string[]>
}

/**
 * The statements of a file that are the guards comb wrote, each exactly as comb writes it (or as
 * comb 0.8 wrote it), the tables each guarded rebuild keeps the rows of, the tables each rebuild
 * leaves under new rowids, and the rebuilt tables of referenced rebuilds left unguarded, with the
 * tables their drop reaches. A guard written before a later file put a trigger on a table it
 * empties fires that trigger: the rebuild is named in `fired`, as diff would have refused it.
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
		const synced = new Set(schema.triggers.filter((t) => t.ftsSync).map((t) => t.name))
		const fired = firedBy(rebuild.table, schema, (name) => synced.has(name))
		if (fired !== undefined) out.fired.set(rebuild.table, firesMessage(rebuild.table, fired))
		out.renumbered.set(
			rebuild.table,
			renumberedBy(rebuild, schema, { closure: guard === current ? closure : [], code: copy }),
		)
		for (let i = rebuild.drop - guard.before.length; i < rebuild.drop; i++) out.guarded.add(i)
		for (let i = 1; i <= guard.after.length; i++) out.guarded.add(rebuild.rename + i)
	}
	return out
}

export { type Guards, noGuards, readGuards }
