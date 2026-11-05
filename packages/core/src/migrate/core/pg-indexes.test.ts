import { describe, expect, it } from "vitest"
import { INDEX_CASES } from "../../../tests/support/pg-index-cases.ts"
import { historyFacts } from "./pg-history.ts"
import { extractSchema } from "./schema.ts"

const P = [
	"CREATE TABLE p (id int NOT NULL, at date NOT NULL) PARTITION BY RANGE (at);",
	"CREATE TABLE p1 PARTITION OF p FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
	"",
].join("\n")

/** Every index comb follows through the history `sql`, rendered as the oracle renders Postgres's catalog */
function indexes(sql: string): string[] {
	const facts = historyFacts(extractSchema(sql, undefined, "postgres"), "public")
	return [...facts.indexes]
		.map(([key, index]) => {
			const partitioned = facts.partitioned.has(index.table) ? " partitioned" : ""
			return `${key} on ${index.table}${partitioned}${index.kind === "index" ? "" : " constraint"}`
		})
		.toSorted()
}

/* PA12 of r22b: each index Postgres makes, under the name ChooseIndexName gives it, through every rename, attach and drop */
describe("followIndexes", () => {
	it.each(INDEX_CASES)("names $label as Postgres does", ({ history, indexes: expected }) => {
		expect(indexes(history)).toEqual(expected)
	})

	/* an index the history cannot read (made by a DO block) is not one comb knows to attach */
	it("leaves an attach of an index the history never made to Postgres", () => {
		const made = "DO $$ BEGIN EXECUTE 'CREATE INDEX p1_at ON p1 (at)'; END $$;"
		const history = `${P}CREATE INDEX p_at ON ONLY p (at);\n${made}\nALTER INDEX p_at ATTACH PARTITION p1_at;`
		expect(indexes(history)).toEqual(["p_at on p partitioned"])
	})
})
