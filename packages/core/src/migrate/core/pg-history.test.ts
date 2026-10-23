import { describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { extractSchema } from "./schema.ts"

const facts = (sql: string) => historyFacts(extractSchema(sql, undefined, "postgres"))

/* T5 and T6 of the 2.3 review: what the history attached to its tables, read from its parse trees */
describe("what a Postgres history attached to its tables", () => {
	it("reads nothing without a history", () => {
		expect(historyFacts(undefined).code).toEqual(new Map())
	})

	it("reads past a statement Postgres cannot parse", () => {
		expect(facts("CREATE TABL broken;\nCREATE TABLE t (id int DEFAULT f());").code).toEqual(new Map([["t", "f"]]))
	})

	it("gives each reader its own copy", () => {
		const schema = extractSchema("CREATE TABLE t (id int DEFAULT f());", undefined, "postgres")
		historyFacts(schema).code.clear()
		expect(historyFacts(schema).code).toEqual(new Map([["t", "f"]]))
	})

	it("keeps the first code a table runs, and none for a pure default or a drop", () => {
		const read = facts(
			"CREATE TABLE t (id int DEFAULT f(), v int DEFAULT g());\nCREATE TABLE u (id int DEFAULT now());\nALTER TABLE u DROP COLUMN id;\nALTER TABLE t ALTER COLUMN v SET DEFAULT h();",
		)
		expect(read.code).toEqual(new Map([["t", "f"]]))
	})

	it("keeps the code a table's first clause runs over a later CHECK or ALTER", () => {
		expect(
			facts(
				"CREATE TABLE t (id int DEFAULT f(), CHECK (g() > 0), CHECK (id > 0));\nALTER TABLE t ADD CONSTRAINT c CHECK (h() > 0);",
			).code,
		).toEqual(new Map([["t", "f"]]))
		expect(facts("CREATE TABLE u (id int, CHECK (g() > 0));").code).toEqual(new Map([["u", "g"]]))
		expect(facts("CREATE TABLE v (id int);\nALTER TABLE v ALTER COLUMN id SET DEFAULT 0;").code).toEqual(new Map())
		expect(facts("CREATE TABLE w (id int);\nALTER TABLE w ALTER COLUMN id SET DEFAULT f();").code).toEqual(
			new Map([["w", "f"]]),
		)
	})
})

describe("what a Postgres history's parents, casts, operators and domains are", () => {
	it("records parents by partition and by inheritance, in other schemas too", () => {
		const read = facts(
			"CREATE TABLE p (id int) PARTITION BY RANGE (id);\nCREATE TABLE s.c PARTITION OF p FOR VALUES FROM (0) TO (1);\nCREATE TABLE i (id int);\nCREATE TABLE j () INHERITS (i);\nCREATE TABLE k (id int);\nALTER TABLE k INHERIT i;\nCREATE TABLE a (id int);\nALTER TABLE p ATTACH PARTITION a FOR VALUES FROM (1) TO (2);",
		)
		expect(read.parents).toEqual(
			new Map([
				["s.c", [{ parent: "p", partition: true }]],
				["j", [{ parent: "i", partition: false }]],
				["k", [{ parent: "i", partition: false }]],
				["a", [{ parent: "p", partition: true }]],
			]),
		)
	})

	it("reads a cast's function, and marks a table only for an implicit or assignment one", () => {
		const read = facts(
			"CREATE TABLE t (m mt, n nt, o ot);\nCREATE CAST (int AS mt) WITH FUNCTION tomt(int);\nCREATE CAST (int AS nt) WITH FUNCTION tont(int) AS ASSIGNMENT;\nCREATE CAST (int AS ot) WITHOUT FUNCTION AS IMPLICIT;",
		)
		expect(read.casts).toEqual(
			new Map([
				["mt", { automatic: false, fn: "tomt" }],
				["nt", { automatic: true, fn: "tont" }],
			]),
		)
		expect(read.code).toEqual(new Map([["t", "tont"]]))
	})

	it("reads an operator's function, named FUNCTION or PROCEDURE", () => {
		expect(facts("CREATE OPERATOR ## (PROCEDURE = hh, LEFTARG = int, RIGHTARG = int);").operators).toEqual(
			new Map([["##", "hh"]]),
		)
	})

	it("keeps a rule's table at the code it already ran", () => {
		expect(
			facts("CREATE TABLE t (id int DEFAULT f());\nCREATE RULE r AS ON INSERT TO t DO ALSO NOTHING;").code,
		).toEqual(new Map([["t", "f"]]))
	})

	it("reads a domain only when its CHECK calls a function", () => {
		expect(facts("CREATE DOMAIN plain AS int;").domains).toEqual(new Map())
		expect(facts("CREATE DOMAIN pos AS int CHECK (VALUE > 0);").domains).toEqual(new Map())
		expect(facts("CREATE DOMAIN pos AS int CHECK (VALUE > f());").domains).toEqual(new Map([["pos", "f"]]))
	})
})
