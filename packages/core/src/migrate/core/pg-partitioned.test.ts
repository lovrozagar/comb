import { describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { extractSchema } from "./schema.ts"

/** The partitioned tables and indexes the history `sql` leaves */
function partitioned(sql: string) {
	const facts = historyFacts(extractSchema(sql, undefined, "postgres"), "public")
	return { indexes: Object.fromEntries(facts.partitionedIndexes), tables: [...facts.partitioned] }
}

const PT = "CREATE TABLE pt (id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE plain (id int);\n"

/* P18 and P19 of r19: what rating reads of a partitioned table and its indexes, through every rename, move and drop */
describe("followPartitioned", () => {
	it("keeps a partitioned table and each named index on it, but an index Postgres names, and a plain table's", () => {
		const sql = `${PT}CREATE INDEX pt_at ON pt (at);\nCREATE INDEX ON pt (id);\nCREATE INDEX plain_id ON plain (id);`
		expect(partitioned(sql)).toEqual({ indexes: { pt_at: "pt" }, tables: ["pt"] })
	})

	it("follows an index renamed, and leaves a plain index's rename alone", () => {
		const sql = `${PT}CREATE INDEX pt_at ON pt (at);\nCREATE INDEX plain_id ON plain (id);\nALTER INDEX pt_at RENAME TO pt_when;\nALTER INDEX plain_id RENAME TO plain_key;`
		expect(partitioned(sql).indexes).toEqual({ pt_when: "pt" })
	})

	it("moves a table's indexes with it to another schema, and a schema renamed takes both along", () => {
		const moved = `${PT}CREATE INDEX pt_at ON pt (at);\nCREATE SCHEMA s;\nALTER TABLE pt RENAME TO qt;\nALTER TABLE qt SET SCHEMA s;\nALTER SEQUENCE IF EXISTS q SET SCHEMA s;\nALTER FUNCTION f() SET SCHEMA s;`
		expect(partitioned(moved)).toEqual({ indexes: { "s.pt_at": "s.qt" }, tables: ["s.qt"] })
		const renamed =
			"CREATE SCHEMA app;\nCREATE TABLE app.pt (at date) PARTITION BY RANGE (at);\nCREATE INDEX pt_at ON app.pt (at);\nALTER SCHEMA app RENAME TO app2;"
		expect(partitioned(renamed)).toEqual({ indexes: { "app2.pt_at": "app2.pt" }, tables: ["app2.pt"] })
	})

	it("drops a table with its indexes, and an index alone", () => {
		const sql = `${PT}CREATE TABLE pu (at date) PARTITION BY RANGE (at);\nCREATE INDEX pt_at ON pt (at);\nCREATE INDEX pu_at ON pu (at);\nCREATE INDEX pu_at2 ON pu (at);\nDROP TABLE pt;\nDROP INDEX pu_at;`
		expect(partitioned(sql)).toEqual({ indexes: { pu_at2: "pu" }, tables: ["pu"] })
	})
})
