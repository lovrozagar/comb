/**
 * r18 P4: a CASCADE drop takes with it what depends on what it drops, in the facts rating reads, as
 * Postgres drops it: a view or materialized view over what it drops, and a trigger running a dropped function.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(() => loadPostgresParser())

/** What rating reads of the facts `sql` leaves: the views and materialized views that read something, and triggers, by key */
function left(sql: string) {
	const facts = historyFacts(extractSchema(sql, undefined, "postgres"), "public")
	return {
		triggers: [...facts.triggers].flatMap(([table, each]) => each.map(({ name }) => `${table}.${name}`)),
		views: [...facts.reads.keys()],
	}
}

const BASE = `CREATE TABLE t (id int, c int, d int); CREATE TABLE u (id int);
CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION ok(int) RETURNS bool LANGUAGE sql STABLE AS 'SELECT true';`

describe("a CASCADE drop in the history (P4 of r18)", () => {
	it("takes the views that read a dropped table, and the views over them", () => {
		const sql = `${BASE} CREATE VIEW v AS SELECT id FROM t; CREATE VIEW w AS SELECT id FROM v; CREATE VIEW x AS SELECT id FROM u;
CREATE MATERIALIZED VIEW m AS SELECT t.id FROM t JOIN u ON u.id = t.id; DROP TABLE t CASCADE;`
		expect(left(sql).views).toEqual(["x"])
	})

	it("keeps them on a drop with no CASCADE", () => {
		expect(left(`${BASE} CREATE VIEW v AS SELECT id FROM t; DROP VIEW IF EXISTS nothing;`).views).toEqual(["v"])
	})

	it("takes the views that call a dropped function, and keeps the others", () => {
		const sql = `${BASE} CREATE VIEW calls AS SELECT id FROM u WHERE ok(id); CREATE VIEW plain AS SELECT id FROM u;
DROP FUNCTION ok(int) CASCADE;`
		expect(left(sql).views).toEqual(["plain"])
	})

	it("takes the triggers that run a dropped function", () => {
		const sql = `${BASE} CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();
CREATE POLICY p ON u USING (ok(id)); CREATE POLICY q ON u USING (true);
DROP FUNCTION f() CASCADE; DROP FUNCTION ok(int) CASCADE;`
		expect(left(sql).triggers).toEqual([])
	})

	it("takes the views that read a dropped column, by name or by *, and keeps the others", () => {
		const sql = `${BASE} CREATE VIEW byname AS SELECT c FROM t; CREATE VIEW star AS SELECT * FROM t;
CREATE VIEW other AS SELECT d FROM t; ALTER TABLE t DROP COLUMN c CASCADE;`
		expect(left(sql).views).toEqual(["other"])
	})

	it("takes what reads a dropped relation, through a rename and a schema drop", () => {
		const renamed = `${BASE} CREATE VIEW v AS SELECT id FROM t; ALTER TABLE t RENAME TO t2; DROP TABLE t2 CASCADE;`
		expect(left(renamed).views).toEqual([])
		const schema = `${BASE} CREATE SCHEMA s; CREATE TABLE s.a (id int); CREATE VIEW va AS SELECT id FROM s.a;
CREATE VIEW s.vb AS SELECT id FROM u; CREATE POLICY p ON u USING (id IN (SELECT id FROM s.a)); DROP SCHEMA s CASCADE;`
		expect(left(schema).views).toEqual([])
	})

	it("takes a view that reads every column, whatever it names after the *", () => {
		const sql = `${BASE} CREATE VIEW star AS SELECT *, id AS again FROM t; CREATE POLICY p ON u USING (id IN (SELECT id FROM t));
ALTER TABLE u RENAME TO u2; ALTER TABLE t DROP COLUMN d CASCADE;`
		expect(left(sql).views).toEqual([])
	})

	it("takes everything in the history's own schema, routines too, when that schema is dropped", () => {
		const sql = `${BASE} CREATE VIEW v AS SELECT id FROM t; CREATE SCHEMA s; CREATE FUNCTION s.g() RETURNS int LANGUAGE sql AS 'SELECT 1';
CREATE TABLE s.k (id int); CREATE TRIGGER tr BEFORE INSERT ON s.k FOR EACH ROW EXECUTE FUNCTION s.g(); DROP SCHEMA s CASCADE; DROP SCHEMA public CASCADE;`
		expect(left(sql)).toEqual({ triggers: [], views: [] })
	})

	it("takes the views that read a column of a dropped type", () => {
		const sql = `CREATE TYPE mood AS ENUM ('ok'); CREATE TABLE t (id int, m mood); CREATE VIEW v AS SELECT m FROM t;
CREATE VIEW w AS SELECT id FROM t; DROP TYPE mood CASCADE;`
		expect(left(sql).views).toEqual(["w"])
		const two = `CREATE TYPE a AS ENUM ('x'); CREATE TYPE b AS ENUM ('y'); CREATE TABLE plain (id int); CREATE TABLE t (id int, ca a, cb b);
CREATE VIEW va AS SELECT ca FROM t; CREATE VIEW vb AS SELECT cb FROM t; CREATE VIEW w AS SELECT id FROM t; DROP TYPE a, b CASCADE;`
		expect(left(two).views).toEqual(["w"])
	})
})
