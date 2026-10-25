/**
 * The rebuild rule of the destructive-change gate, for SQLite: a drop that Atlas's copy, rename and
 * the history make a table rebuild is lossless when its copy writes every column the table had,
 * into a new table that stores each as the old one did. Anything else loses rows or values.
 */
import type { Dialect, ExtractedSchema } from "../types.ts"
import type { Finding } from "./classify-alter.ts"
import { NO_TRANSACTION, type Rebuilds } from "./rebuild-copy.ts"
import { extractSchema } from "./schema.ts"
import { nameKey, type Naming } from "./sql-code.ts"
import { definitionDrift } from "./sqlite-affinity.ts"

/** What the rebuild rule reads of a file */
type RebuildContext = {
	before: ExtractedSchema | undefined
	dialect: Dialect
	/** how names are keyed: SQLite's way, or Postgres's under its schema */
	naming: Naming
	/** how many DROPs of each rebuilt table the file has read so far: the next pairs with the next rebuild */
	drops: Map<string, number>
	/** rebuilt tables whose guard fires a trigger as it keeps their rows, with why */
	fired: Map<string, string>
	/** rebuilt tables comb guarded, with the tables whose rows the guard keeps */
	kept: Map<string, string[]>
	rebuilds: Rebuilds
	/** each rebuilt table's notes of the tables it leaves under new rowids */
	renumbered: Map<string, string[]>
	/** a SQLite file Atlas runs outside a transaction, as `-- atlas:txmode none` asks */
	txmodeNone: boolean
	/** rebuilt tables others reference whose rebuild comb did not guard, with the tables their drop reaches */
	unguarded: Map<string, string[]>
}

type FileRebuild = { columns: string[]; definition: string; problem: string | undefined; temp: string }

/** Why a rebuild of `name` loses rows or values before its copy is read, if it does */
function rebuildRefusal(name: string, rebuild: FileRebuild, ctx: RebuildContext): Finding | undefined {
	if (ctx.txmodeNone) return { level: "unsafe", note: `rebuilds ${name}: ${NO_TRANSACTION}` }
	if (ctx.before?.tables.get(name) === undefined)
		return { level: "unsafe", note: `rebuilds ${name}, whose earlier columns are unknown` }
	const fires = ctx.fired.get(name)
	if (fires !== undefined) return { level: "unsafe", note: `rebuilds ${name}: its guard ${fires}` }
	const reached = ctx.unguarded.get(name)
	if (reached !== undefined) {
		return {
			level: "unsafe",
			note: `rebuilds ${name} unguarded: its drop deletes or orphans the rows of ${reached.join(", ")}; let comb migrate diff write it`,
		}
	}
	return rebuild.problem === undefined ? undefined : { level: "unsafe", note: `rebuilds ${name}: ${rebuild.problem}` }
}

/**
 * What a rebuild's new table does to the table's earlier columns: the ones it stores (a generated
 * column the new table still generates is recomputed, never copied), and what its definition
 * changes in the ones it copies
 */
function copyOutcome(
	name: string,
	rebuild: FileRebuild,
	before: ExtractedSchema,
): { drift: string | undefined; stored: string[] } {
	const was = before.tableInfo.get(name)
	const next = extractSchema(rebuild.definition).tableInfo.get(rebuild.temp)
	const generated = (column: string) =>
		was?.generatedColumns.includes(column) === true && next?.generatedColumns.includes(column) === true
	/* rebuildRefusal returned for a table whose earlier columns are unknown */
	const stored = (before.tables.get(name) as string[]).filter((column) => !generated(column))
	const copied = stored.filter((column) => rebuild.columns.includes(column))
	return { drift: was === undefined || next === undefined ? undefined : definitionDrift(was, next, copied), stored }
}

/** A SQLite drop that is a table rebuild: lossless when it copies every column the table had, as it had it */
function rebuildFinding(table: string | undefined, ctx: RebuildContext): Finding | undefined {
	const name = table === undefined ? undefined : nameKey(table, ctx.naming)
	const rebuilt = name === undefined ? undefined : ctx.rebuilds.get(name)
	if (name === undefined || rebuilt === undefined) return undefined
	/* each DROP pairs with its own rebuild, by position: a clean one later cannot launder a lossy one (M5) */
	const nth = ctx.drops.get(name) ?? 0
	ctx.drops.set(name, nth + 1)
	const rebuild = rebuilt[Math.min(nth, rebuilt.length - 1)] as FileRebuild
	const refusal = rebuildRefusal(name, rebuild, ctx)
	if (refusal !== undefined) return refusal
	const { drift, stored } = copyOutcome(name, rebuild, ctx.before as ExtractedSchema)
	if (drift !== undefined) return { level: "unsafe", note: `rebuilds ${name}: its new table ${drift}` }
	const lost = stored.filter((column) => !rebuild.columns.includes(column))
	const kept = ctx.kept.get(name)
	const renumbered = (ctx.renumbered.get(name) ?? []).map((note) => `; ${note}`).join("")
	if (lost.length === 0 && kept !== undefined)
		return { level: "cautious", note: `rebuilds ${name}; comb keeps the rows of ${kept.join(", ")}${renumbered}` }
	if (lost.length === 0) return { level: "cautious", note: `rebuilds ${name}, copying every column${renumbered}` }
	return {
		drops: lost.map((column) => `DROP COLUMN ${name}.${column}`),
		level: "unsafe",
		note: `rebuilds ${name} without ${lost.join(", ")}`,
	}
}

export { type RebuildContext, rebuildFinding }
