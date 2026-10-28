import { describe, expect, it } from "vitest"
import type { Facts } from "./pg-history.ts"
import { followParentage, reachFindings, useFinding } from "./pg-reach.ts"
import { freshStart } from "./classify-write.ts"

const FACTS: Facts = {
	casts: new Map([["mt", { automatic: true, fn: "tomt" }]]),
	code: new Map([["c", "f"]]),
	columnTypes: new Map(),
	defined: new Set(),
	eventTriggers: new Map(),
	domains: new Map(),
	operators: new Map([["===", "eq3"]]),
	routines: new Map(),
	schema: "public",
	tables: new Map(),
	views: new Map(),
	parents: new Map([
		["c", [{ parent: "p", partition: true }]],
		["g", [{ parent: "c", partition: true }]],
	]),
	triggers: new Map(),
}

const notes = (key: string, inh: boolean) =>
	reachFindings({ inh, key }, ["insert"], { facts: FACTS }).map((finding) => finding.note)
const op = (name: string) => ({ name: [{ String: { sval: name } }] })
const cast = (type: string) => ({ typeName: { names: [{ String: { sval: type } }] } })
const attach = (child: string) => ({
	cmds: [
		{
			AlterTableCmd: {
				def: { PartitionCmd: { name: { relname: child, relpersistence: "p" } } },
				subtype: "AT_AttachPartition",
			},
		},
	],
	relation: { relname: "q", relpersistence: "p" },
})

/* T5 and T6 of the 2.3 review: what a write reaches past the table it names */
describe("a Postgres write's reach", () => {
	it("reaches every descendant, and a partition's parents, without ONLY", () => {
		expect(notes("p", true)).toEqual(["runs f on every write to c"])
		expect(notes("p", false)).toEqual([])
		expect(notes("g", false)).toEqual(["runs f on every write to c"])
	})

	it("reads an operator or cast a migration defined, and nothing of another", () => {
		expect(useFinding("A_Expr", op("==="), FACTS)?.note).toBe("uses operator ===, which a migration defined (eq3)")
		expect(useFinding("A_Expr", op("+"), FACTS)).toBeUndefined()
		expect(useFinding("A_Expr", { kind: "AEXPR_IN" }, FACTS)).toBeUndefined()
		expect(useFinding("TypeCast", cast("mt"), FACTS)?.level).toBe("unsafe")
		expect(useFinding("TypeCast", cast("text"), FACTS)).toBeUndefined()
	})

	it("keeps a parent fresh when the child it takes is fresh too", () => {
		const fresh = freshStart()
		fresh.tables.add("q").add("r")
		followParentage(attach("r"), fresh, "public")
		expect(fresh.tables.has("q")).toBe(true)
		followParentage(attach("users"), fresh, "public")
		expect(fresh.tables.has("q")).toBe(false)
	})
})
