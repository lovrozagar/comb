import { beforeAll, describe, expect, it } from "vitest"
import { freshStart } from "./classify-write.ts"
import { followFresh } from "./pg-fresh.ts"
import { historyFacts } from "./pg-history.ts"
import { nodesOf } from "./pg-nodes.ts"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(() => loadPostgresParser())

/** The facts of a history that made `had (a)` */
const facts = () => historyFacts(extractSchema("CREATE TABLE had (a int);", undefined, "postgres"), "public")

/** `fresh` after each statement of `sql`, followed in order */
function after(sql: string) {
	const ctx = { facts: facts(), fresh: freshStart() }
	for (const [type, node] of nodesOf(postgresParser().parseSync(sql).stmts)) followFresh(type, node, ctx)
	return ctx.fresh
}

describe("followFresh: what a file makes new, keyed as the parser names it", () => {
	it("makes a table new without IF NOT EXISTS and a name the history does not show", () => {
		expect([...after('CREATE TABLE U&"\\0061" (id int)').tables]).toEqual(["a"])
		expect([...after("CREATE TABLE IF NOT EXISTS b (id int)").tables]).toEqual([])
		expect([...after("CREATE TABLE had (id int)").tables]).toEqual([])
	})

	it("adds a column new, folded, unless IF NOT EXISTS or the table had it", () => {
		expect(after("ALTER TABLE had ADD COLUMN Note text").columns).toEqual(new Map([["had", new Set(["note"])]]))
		expect(after("ALTER TABLE had ADD COLUMN IF NOT EXISTS n int").columns).toEqual(new Map())
		expect(after("ALTER TABLE had ADD COLUMN a int, DROP COLUMN x").columns).toEqual(new Map())
	})

	it("keeps a table fresh through an INSERT … VALUES, never an INSERT … SELECT", () => {
		expect([...after("CREATE TABLE n (id int); INSERT INTO n VALUES (1)").tables]).toEqual(["n"])
		expect([...after("CREATE TABLE n (id int); INSERT INTO n SELECT 1").tables]).toEqual([])
		expect([...after("CREATE TABLE n (id int); INSERT INTO n DEFAULT VALUES").tables]).toEqual(["n"])
	})
})
