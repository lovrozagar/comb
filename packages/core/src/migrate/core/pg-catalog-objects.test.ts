/**
 * P9 of the 0.15.0 review: the views, materialized views and sequences a Postgres history leaves,
 * and each table's policies, which a baseline compares by name; a sequence a column owns is the
 * column's.
 */
import { describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { extractSchema } from "./schema.ts"

/** What `sql`'s history leaves of relations and policies */
function left(sql: string) {
	const facts = historyFacts(extractSchema(sql, undefined, "postgres"), "public")
	return {
		policies: Object.fromEntries([...facts.policies].map(([table, each]) => [table, [...each.keys()].sort()])),
		relations: Object.fromEntries(facts.relations),
	}
}

describe("the views, sequences and policies a Postgres history leaves", () => {
	it("keeps each by key, a sequence OWNED BY a column marked as the column's", () => {
		expect(
			left(`CREATE TABLE u (id int);
CREATE VIEW app.v AS SELECT 1;
CREATE MATERIALIZED VIEW m AS SELECT 1;
CREATE SEQUENCE s;
CREATE SEQUENCE o OWNED BY u.id;
CREATE POLICY p ON u USING (true);
CREATE POLICY q ON app.w USING (true);`),
		).toEqual({
			policies: { "app.w": ["q"], u: ["p"] },
			relations: { "app.v": "view", m: "materialized view", o: "owned sequence", s: "sequence" },
		})
	})

	it("follows a sequence given to a column and back, an IF NOT EXISTS that changes nothing, and a policy renamed or dropped", () => {
		expect(
			left(`CREATE TABLE u (id int);
CREATE SEQUENCE s;
CREATE SEQUENCE IF NOT EXISTS s OWNED BY u.id;
CREATE SEQUENCE t;
ALTER SEQUENCE t OWNED BY u.id;
CREATE SEQUENCE n OWNED BY u.id;
ALTER SEQUENCE n OWNED BY NONE;
ALTER SEQUENCE n RESTART;
ALTER SEQUENCE ghost OWNED BY u.id;
CREATE POLICY p ON u USING (true);
CREATE POLICY q ON u USING (true);
ALTER POLICY p ON u RENAME TO r;
ALTER POLICY ghost ON v RENAME TO z;
DROP POLICY q ON public.u;`),
		).toEqual({ policies: { u: ["r"] }, relations: { n: "sequence", s: "sequence", t: "owned sequence" } })
	})
})

/* P10 of r18: a policy's command, roles and kind, which a baseline compares, through an ALTER */
describe("a Postgres history's policies, with their settings", () => {
	it("keeps a policy's command, roles and kind, the roles an ALTER POLICY gives, and what its checks read", () => {
		const facts = historyFacts(
			extractSchema(
				`CREATE TABLE u (id int);
CREATE POLICY p ON u AS RESTRICTIVE FOR UPDATE TO b, PUBLIC, CURRENT_USER USING (true);
CREATE POLICY q ON u USING (true);
ALTER POLICY p ON u TO b, a WITH CHECK (id IN (SELECT id FROM t));
ALTER POLICY q ON u USING (id > 0);
ALTER POLICY ghost ON u TO a;`,
				undefined,
				"postgres",
			),
			"public",
		)
		const [p, q] = [facts.policies.get("u")?.get("p"), facts.policies.get("u")?.get("q")]
		expect([p?.cmd, p?.permissive, p?.roles, [...(p?.reads.relations ?? [])]]).toEqual([
			"update",
			false,
			["a", "b"],
			["t"],
		])
		expect([q?.cmd, q?.permissive, q?.roles]).toEqual(["all", true, ["public"]])
	})
})

describe("what a DROP takes", () => {
	it("drops what a DROP names, and a table's policies with it", () => {
		expect(
			left(`CREATE TABLE u (id int);
CREATE VIEW v AS SELECT 1;
CREATE SEQUENCE s;
CREATE POLICY p ON u USING (true);
DROP VIEW v;
DROP SEQUENCE s;
DROP TABLE u;`),
		).toEqual({ policies: {}, relations: {} })
	})
})
