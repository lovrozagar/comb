import { beforeAll, describe, expect, it } from "vitest"
import { ARM_KINDS, CATALOG, COMPARED } from "./pg-live-catalog.ts"
import type { Node } from "./pg-nodes.ts"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"

beforeAll(() => loadPostgresParser())

/** The arms of a UNION ALL, in order */
function arms(select: Node): Node[] {
	if (select["op"] !== "SETOP_UNION") return [select]
	return [...arms(select["larg"] as Node), ...arms(select["rarg"] as Node)]
}

describe("CATALOG", () => {
	it("reads every kind in one statement, each arm naming what it is in the same eight columns", () => {
		const [stmt] = postgresParser().parseSync(CATALOG).stmts as Array<{ stmt: Node }>
		const each = arms((stmt as { stmt: Node }).stmt["SelectStmt"] as Node)
		expect(each.map((arm) => ((arm["targetList"] as Node[]) ?? []).length)).toEqual(each.map(() => 8))
		const whats = each.map((arm) => {
			const first = ((arm["targetList"] as Node[])[0] as Node)["ResTarget"] as Node
			return (((first["val"] as Node)["A_Const"] as Node)["sval"] as Node)["sval"]
		})
		expect(whats).toEqual([
			"routine",
			"trigger",
			"relation",
			"policy",
			"kind",
			"kind",
			"rule",
			"rls",
			"extension",
			/* P12 of r19: aggregates, SECURITY DEFINER, operators, casts, view options, matview indexes, replica identity */
			"other",
			"other",
			"other",
			"other",
			"other",
			"other",
			"other",
			"platform",
			"platform",
			"user",
		])
	})

	/* the refusal's list went stale once by hand (3a084d1): it is now each arm's kinds, which this ties to the arms */
	it("names what every arm compares, in COMPARED and nowhere else, so a new arm cannot go unnamed", () => {
		const [stmt] = postgresParser().parseSync(CATALOG).stmts as Array<{ stmt: Node }>
		const whats = arms((stmt as { stmt: Node }).stmt["SelectStmt"] as Node).map((arm) => {
			const first = ((arm["targetList"] as Node[])[0] as Node)["ResTarget"] as Node
			return (((first["val"] as Node)["A_Const"] as Node)["sval"] as Node)["sval"]
		})
		expect(ARM_KINDS.map(([what]) => what)).toEqual(whats)
		for (const [what, kinds] of ARM_KINDS) expect([what, kinds.length > 0]).toEqual([what, what !== "user"])
		expect(COMPARED.split(/, | and (?=[^,]*$)/)).toEqual(ARM_KINDS.flatMap(([, kinds]) => kinds))
	})
})
