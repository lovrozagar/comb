/**
 * r18 P4: a CASCADE drop takes with it what depends on what it drops, in the history's facts as in
 * Postgres, so baseline compares a database apply built from the same files as equal.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(() => loadPostgresParser())

/** What baseline compares of the facts `sql` leaves: relations, triggers and policies, by key */
function left(sql: string) {
	const facts = historyFacts(extractSchema(sql, undefined, "postgres"), "public")
	return {
		policies: [...facts.policies].flatMap(([table, names]) => [...names].map((name) => `${table}.${name}`)),
		relations: [...facts.relations.keys()],
		triggers: [...facts.triggers].flatMap(([table, each]) => each.map(({ name }) => `${table}.${name}`)),
	}
}

const BASE = `CREATE TABLE t (id int, c int, d int); CREATE TABLE u (id int);
CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION ok(int) RETURNS bool LANGUAGE sql STABLE AS 'SELECT true';`

describe("a CASCADE drop in the history (P4 of r18)", () => {
	it("takes the views that read a dropped table, and the views over them", () => {
		const sql = `${BASE} CREATE VIEW v AS SELECT id FROM t; CREATE VIEW w AS SELECT id FROM v; CREATE VIEW x AS SELECT id FROM u;
CREATE MATERIALIZED VIEW m AS SELECT t.id FROM t JOIN u ON u.id = t.id; DROP TABLE t CASCADE;`
		expect(left(sql).relations).toEqual(["x"])
	})

	it("keeps them on a drop with no CASCADE", () => {
		expect(left(`${BASE} CREATE VIEW v AS SELECT id FROM t; DROP VIEW IF EXISTS nothing;`).relations).toEqual(["v"])
	})

	it("takes the triggers that run a dropped function, and the policies that call one", () => {
		const sql = `${BASE} CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();
CREATE POLICY p ON u USING (ok(id)); CREATE POLICY q ON u USING (true);
DROP FUNCTION f() CASCADE; DROP FUNCTION ok(int) CASCADE;`
		expect([left(sql).triggers, left(sql).policies]).toEqual([[], ["u.q"]])
	})

	it("takes the views that read a dropped column, by name or by *, and keeps the others", () => {
		const sql = `${BASE} CREATE VIEW byname AS SELECT c FROM t; CREATE VIEW star AS SELECT * FROM t;
CREATE VIEW other AS SELECT d FROM t; ALTER TABLE t DROP COLUMN c CASCADE;`
		expect(left(sql).relations).toEqual(["other"])
	})

	it("takes what reads a policy's table's dropped relation, through a rename and a schema drop", () => {
		const renamed = `${BASE} CREATE VIEW v AS SELECT id FROM t; ALTER TABLE t RENAME TO t2; DROP TABLE t2 CASCADE;`
		expect(left(renamed).relations).toEqual([])
		const schema = `${BASE} CREATE SCHEMA s; CREATE TABLE s.a (id int); CREATE VIEW va AS SELECT id FROM s.a;
CREATE VIEW s.vb AS SELECT id FROM u; CREATE POLICY p ON u USING (id IN (SELECT id FROM s.a)); DROP SCHEMA s CASCADE;`
		expect([left(schema).relations, left(schema).policies]).toEqual([[], []])
	})

	it("takes the views that read a column of a dropped type", () => {
		const sql = `CREATE TYPE mood AS ENUM ('ok'); CREATE TABLE t (id int, m mood); CREATE VIEW v AS SELECT m FROM t;
CREATE VIEW w AS SELECT id FROM t; DROP TYPE mood CASCADE;`
		expect(left(sql).relations).toEqual(["w"])
	})
})
