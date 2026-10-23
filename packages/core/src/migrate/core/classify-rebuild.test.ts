import { describe, expect, it } from "vitest"
import { type RebuildContext, rebuildFinding } from "./classify-rebuild.ts"
import { extractSchema } from "./schema.ts"

const before = extractSchema("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT);")
const rebuild = {
	columns: ["id", "a"],
	definition: "CREATE TABLE new_t (id INTEGER PRIMARY KEY, a TEXT)",
	problem: undefined,
	temp: "new_t",
}

/** What the rule reads, with the rebuild of t as given */
const context = (over: Partial<RebuildContext> = {}): RebuildContext => ({
	before,
	dialect: "sqlite",
	kept: new Map(),
	drops: new Map(),
	rebuilds: new Map([["t", [rebuild]]]),
	renumbered: new Map(),
	txmodeNone: false,
	unguarded: new Map(),
	...over,
})

describe("rebuildFinding", () => {
	it("reads no drop it does not know as a rebuild", () => {
		expect(rebuildFinding(undefined, context())).toBeUndefined()
		expect(rebuildFinding("other", context())).toBeUndefined()
	})

	it("refuses a rebuild outside the file's transaction, of unknown columns, unguarded, or with a changed copy", () => {
		expect(rebuildFinding("t", context({ txmodeNone: true }))?.level).toBe("unsafe")
		expect(rebuildFinding("T", context({ before: undefined }))?.note).toBe(
			"rebuilds t, whose earlier columns are unknown",
		)
		expect(rebuildFinding("t", context({ unguarded: new Map([["t", ["c"]]]) }))?.note).toContain("rebuilds t unguarded")
		const changed = new Map([["t", [{ ...rebuild, problem: "its copy is changed before the rename" }]]])
		expect(rebuildFinding("t", context({ rebuilds: changed }))?.note).toBe(
			"rebuilds t: its copy is changed before the rename",
		)
	})

	it("rates a copy of every column into an equal table cautious, naming what the guard keeps and renumbers", () => {
		expect(rebuildFinding("t", context())).toEqual({ level: "cautious", note: "rebuilds t, copying every column" })
		expect(
			rebuildFinding(
				"t",
				context({ kept: new Map([["t", ["c"]]]), renumbered: new Map([["t", ["c gets new rowids"]]]) }),
			),
		).toEqual({
			level: "cautious",
			note: "rebuilds t; comb keeps the rows of c; c gets new rowids",
		})
	})

	it("rates a copy that leaves a column out, or retypes one, unsafe", () => {
		const without = new Map([["t", [{ ...rebuild, columns: ["id"] }]]])
		expect(rebuildFinding("t", context({ rebuilds: without }))).toEqual({
			drops: ["DROP COLUMN t.a"],
			level: "unsafe",
			note: "rebuilds t without a",
		})
		const retyped = new Map([
			["t", [{ ...rebuild, definition: "CREATE TABLE new_t (id INTEGER PRIMARY KEY, a INTEGER)" }]],
		])
		expect(rebuildFinding("t", context({ rebuilds: retyped }))?.note).toContain(
			"changes a's affinity from TEXT to INTEGER",
		)
		const undefinedCopy = new Map([["t", [{ ...rebuild, definition: "" }]]])
		expect(rebuildFinding("t", context({ rebuilds: undefinedCopy }))?.level).toBe("cautious")
	})
})
