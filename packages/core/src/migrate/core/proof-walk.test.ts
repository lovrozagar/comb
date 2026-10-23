import { describe, expect, it } from "vitest"
import { engineFindings } from "./proof-engine.ts"
import { type Context, walkProgram } from "./proof-walk.ts"

/* main holds k at root 2, its index at root 3; t is no existing table */
const CTX: Context = {
	existing: new Set(["k"]),
	main: new Map([
		[2, "k"],
		[3, "k"],
		[4, "t"],
	]),
	probes: [],
	tables: new Set([2, 4]),
	watched: new Set(),
}

/** A program of `ops`, each `[opcode, p1, p2, p3, p4]`, behind the main program's Init */
const program = (...ops: Array<[string, number, number?, number?, string?]>) => [
	{ addr: 0, opcode: "Init", p1: 0, p2: 0, p3: 0, p4: null, p5: 0 },
	...ops.map(([opcode, p1, p2 = 0, p3 = 0, p4], i) => ({ addr: i + 1, opcode, p1, p2, p3, p4, p5: 0 })),
]

/* no statement SQLite compiles today reaches these; the walk refuses what it cannot read all the same */
describe("the walk, default-deny", () => {
	it("names an opcode it cannot read on a write cursor of an existing table, and nothing on another cursor", () => {
		const effects = walkProgram(
			program(["OpenWrite", 0, 2], ["ResetSorter", 0], ["OpenWrite", 1, 4], ["ResetSorter", 1]),
			CTX,
		)
		expect([...effects.unread]).toEqual(["k (ResetSorter)"])
	})

	it("calls a Destroy or DropTable of an existing table a drop, and of an index, temp's or a new table none", () => {
		const effects = walkProgram(
			program(
				["Destroy", 2, 0, 0],
				["Destroy", 3, 0, 0],
				["Destroy", 2, 0, 1],
				["DropTable", 0, 0, 0, "K"],
				["DropTable", 1, 0, 0, "k"],
				["DropTable", 0, 0, 0, "t"],
				["Clear", 2, 1],
			),
			CTX,
		)
		expect([...effects.drops]).toEqual(["k"])
		expect([...effects.deletes]).toEqual([])
	})

	it("gives each a note that makes the file unsafe", () => {
		const effects = walkProgram(program(["Destroy", 2], ["OpenWrite", 0, 2], ["ResetSorter", 0]), CTX)
		expect(engineFindings([{ classified: false, effects, shadows: [], statement: "X" }], new Map()).unsafe).toEqual([
			"X: drops k outside a DROP TABLE",
			"X: does what comb cannot read to k (ResetSorter)",
		])
	})
})
