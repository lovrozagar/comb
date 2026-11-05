import { describe, expect, it } from "vitest"
import { besideTable, lineage } from "./pg-index-facts.ts"
import { historyFacts } from "./pg-history.ts"
import { extractSchema } from "./schema.ts"

describe("besideTable", () => {
	it("keys an index in its table's schema, unqualified in the history's", () => {
		expect(besideTable("t", "i", "public")).toBe("i")
		expect(besideTable("s.t", "i", "public")).toBe("s.i")
		expect(besideTable("public.t", "i", "public")).toBe("i")
	})
})

describe("lineage", () => {
	it("walks a table's partitions and theirs, in the order the history attached them", () => {
		const facts = historyFacts(
			extractSchema(
				[
					"CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);",
					"CREATE TABLE p2 PARTITION OF p FOR VALUES FROM ('2021-01-01') TO ('2022-01-01') PARTITION BY LIST (id);",
					"CREATE TABLE p1 PARTITION OF p FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
					"CREATE TABLE p2a PARTITION OF p2 FOR VALUES IN (1);",
					"CREATE TABLE plain (id int);",
				].join("\n"),
				undefined,
				"postgres",
			),
			"public",
		)
		expect(lineage(facts, "p")).toEqual(["p", "p2", "p2a", "p1"])
		expect(lineage(facts, "plain")).toEqual(["plain"])
	})
})
