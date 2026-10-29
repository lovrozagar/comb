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
		policies: Object.fromEntries([...facts.policies].map(([table, each]) => [table, [...each].sort()])),
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
