/**
 * S1n: 0.21 took `kind` in place of 0.20's `d1: true`. TypeScript refuses `{ d1: true }` alone, but an
 * options object that also sets another field compiles, and JavaScript takes anything: the D1 gate was
 * skipped without a word. Each entry now refuses an option it does not take, naming it and the ones it does.
 */
import { describe, expect, it } from "vitest"
import type { ClassifyOptions } from "./classify.ts"
import { classifyMigration, extractDropStatements } from "./classify.ts"
import { parseMigration } from "./parse.ts"

/* the 0.20 options, as a caller the types do not reach passes them */
const legacy = (options: Record<string, unknown>) => options as ClassifyOptions

const ENTRIES = [
	["classifyMigration", (options: ClassifyOptions) => classifyMigration("CREATE TABLE t (a);", options)],
	["parseMigration", (options: ClassifyOptions) => parseMigration("CREATE TABLE t (a);", "1_t.sql", options)],
	["extractDropStatements", (options: ClassifyOptions) => extractDropStatements("DROP TABLE t;", options)],
] as const

describe.each(ENTRIES)("%s's options (S1n)", (entry, run) => {
	it.each([{ d1: true }, { d1: true, dialect: "sqlite" }, { d1: false }])(
		"refuses %o, naming d1 and the options it takes, kind among them",
		(options) => {
			expect(() => run(legacy(options))).toThrow(TypeError)
			expect(() => run(legacy(options))).toThrow(
				`${entry} takes no option d1; it takes before, kind, dialect and schema (pass kind: "d1" in place of d1: true)`,
			)
		},
	)

	it("names every option it does not take", () => {
		expect(() => run(legacy({ dialect: "sqlite", target: "d1", verbose: true }))).toThrow(
			`${entry} takes no options target, verbose; it takes before, kind, dialect and schema`,
		)
	})

	it('takes { kind: "d1" }, every option it names, and none', () => {
		expect(() => run({ kind: "d1" })).not.toThrow()
		expect(() => run({ before: undefined, dialect: "sqlite", kind: "local", schema: "public" })).not.toThrow()
		expect(() => run({})).not.toThrow()
	})
})
