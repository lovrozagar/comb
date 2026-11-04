/**
 * The options classifyMigration, parseMigration and extractDropStatements take, checked as they are
 * given (S1n of plan 21): 0.21 took `kind` in place of 0.20's `d1: true`, and an options object that
 * also sets another field compiles, as JavaScript takes anything, so `d1` was read as unset and a D1
 * file classified as a local SQLite file's. An option an entry does not take is refused, named, with
 * the ones it does.
 */
import type { ClassifyOptions } from "./classify.ts"

// lookup-table: every option ClassifyOptions declares, and none it does not, so a field added there must be added here
const TAKEN: Readonly<Record<keyof ClassifyOptions, true>> = { before: true, kind: true, dialect: true, schema: true }

/** `options`, refused by a TypeError naming each option `entry` does not take */
function takenOptions(entry: string, options: ClassifyOptions): ClassifyOptions {
	const unknown = Object.keys(options).filter((key) => !Object.hasOwn(TAKEN, key))
	if (unknown.length === 0) return options
	const named = unknown.length === 1 ? `option ${unknown[0] as string}` : `options ${unknown.join(", ")}`
	const taken = Object.keys(TAKEN)
	const d1 = unknown.includes("d1") ? ' (pass kind: "d1" in place of d1: true)' : ""
	throw new TypeError(
		`${entry} takes no ${named}; it takes ${taken.slice(0, -1).join(", ")} and ${taken.at(-1) as string}${d1}`,
	)
}

export { takenOptions }
