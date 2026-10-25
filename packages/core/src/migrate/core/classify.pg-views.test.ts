/**
 * M71 of the 0.13.0 round: an auto-updatable view writes its base table, so a write through it
 * runs the base table's triggers, rules and defaults; a view comb cannot resolve to one table is
 * unsafe to write; and a view's own INSTEAD OF trigger follows it through a rename.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const BASE = `CREATE TABLE victim (id int PRIMARY KEY);
CREATE FUNCTION wipe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM victim; RETURN NEW; END $$;
CREATE TABLE users (id int, email text);`
const TRIGGERED = `${BASE} CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe();`

/** `later`'s rating and notes after `history`, read as Postgres */
function rate(history: string, later: string) {
	const before = extractSchema(history, undefined, "postgres")
	const result = classifyMigration(later, { before, dialect: "postgres" })
	return { notes: result.unsafeStatements.join(" "), safety: result.safety }
}

describe("a Postgres write through a view (M71)", () => {
	it("fires the base table's trigger, the view made in the history or in the file", () => {
		expect(
			rate(`${TRIGGERED} CREATE VIEW v AS SELECT * FROM users;`, "INSERT INTO v VALUES (1, 'x');").notes,
		).toContain("fires trigger t")
		expect(rate(TRIGGERED, "CREATE VIEW v2 AS SELECT * FROM users; INSERT INTO v2 VALUES (1, 'x');").notes).toContain(
			"fires trigger t",
		)
	})

	it("follows a view over a view, and one over a table in another schema", () => {
		const nested = `${TRIGGERED} CREATE VIEW v AS SELECT * FROM users; CREATE VIEW w AS SELECT id FROM v;`
		expect(rate(nested, "INSERT INTO w VALUES (1);").notes).toContain("fires trigger t")
		const other = `${BASE} CREATE SCHEMA s; CREATE TABLE s.u (id int); CREATE TRIGGER t AFTER INSERT ON s.u FOR EACH ROW EXECUTE FUNCTION wipe(); CREATE VIEW pv AS SELECT * FROM s.u;`
		expect(rate(other, "INSERT INTO pv VALUES (1);").notes).toContain("fires trigger t")
	})

	it("follows a view and its base through a schema renamed", () => {
		const history = `${BASE} CREATE SCHEMA app; CREATE TABLE app.u (id int); CREATE TRIGGER t AFTER INSERT ON app.u FOR EACH ROW EXECUTE FUNCTION wipe();
CREATE VIEW app.v AS SELECT * FROM app.u; CREATE VIEW app.j AS SELECT 1 AS x FROM app.u, users; ALTER SCHEMA app RENAME TO app2;`
		expect(rate(history, "INSERT INTO app2.v VALUES (1);").notes).toContain("fires trigger t")
		expect(rate(history, "DELETE FROM app2.j;").notes).toContain("writes through the view app2.j")
	})

	it("runs the base table's rule and default", () => {
		const rule = `${BASE} CREATE RULE r AS ON INSERT TO users DO ALSO DELETE FROM victim; CREATE VIEW v AS SELECT * FROM users;`
		expect(rate(rule, "INSERT INTO v VALUES (1, 'x');").safety).toBe("unsafe")
		const fn = `${BASE} CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN DELETE FROM victim; RETURN 1; END $$; CREATE TABLE d (id int, n int DEFAULT f()); CREATE VIEW v AS SELECT id FROM d;`
		expect(rate(fn, "INSERT INTO v VALUES (1);").notes).toContain("runs f")
	})

	it("keeps a view's INSTEAD OF trigger through ALTER VIEW … RENAME", () => {
		const history = `${BASE} CREATE VIEW v AS SELECT * FROM users; CREATE TRIGGER t INSTEAD OF INSERT ON v FOR EACH ROW EXECUTE FUNCTION wipe(); ALTER VIEW v RENAME TO v2;`
		expect(rate(history, "INSERT INTO v2 VALUES (1, 'x');").notes).toContain("fires trigger t")
	})
})

describe("a Postgres view's columns, and a view comb cannot follow (M71)", () => {
	it("maps a view's renamed column to its base column", () => {
		const renamed = `${BASE} CREATE VIEW v AS SELECT id, email AS mail FROM users;`
		expect(rate(renamed, "UPDATE v SET mail = NULL;").notes).toContain("updates existing rows of users (email)")
	})

	it("follows a view column renamed with ALTER VIEW, a view over a view's renamed column, and an upsert", () => {
		const renamed = `${BASE} CREATE VIEW v AS SELECT id, email AS mail FROM users; ALTER VIEW v RENAME COLUMN mail TO m;`
		expect(rate(renamed, "UPDATE v SET m = NULL;").notes).toContain("users (email)")
		const nested = `${BASE} CREATE VIEW v AS SELECT id, email AS mail FROM users; CREATE VIEW w AS SELECT mail AS x FROM v;`
		expect(rate(nested, "UPDATE w SET x = NULL;").notes).toContain("users (email)")
		const upsert = "INSERT INTO v VALUES (1, 'a') ON CONFLICT (id) DO UPDATE SET mail = 'b';"
		expect(rate(`${BASE} CREATE VIEW v AS SELECT id, email AS mail FROM users;`, upsert).notes).toContain(
			"users (email)",
		)
		expect(
			rate(`${BASE} CREATE VIEW v AS SELECT id, email AS mail FROM users;`, "UPDATE v SET ghost = 1;").notes,
		).toContain("users (ghost)")
		/* a star view passes every column through, and its columns cannot be renamed apart from the base's */
		const star = `${BASE} CREATE VIEW s AS SELECT * FROM users; ALTER VIEW s RENAME COLUMN email TO e;`
		expect(rate(star, "UPDATE s SET email = NULL;").notes).toContain("users (email)")
	})

	it("rates a write to a view comb cannot resolve to one table unsafe, naming the view", () => {
		const joined = `${BASE} CREATE TABLE o (id int); CREATE VIEW j AS SELECT users.id FROM users JOIN o USING (id);`
		expect(rate(joined, "UPDATE j SET id = 2;").notes).toContain("writes through the view j")
		expect(rate(`${BASE} CREATE VIEW c AS VALUES (1);`, "DELETE FROM c;").notes).toContain("writes through the view c")
		/* a control: a write to the table itself, with nothing attached, is the write it is */
		expect(rate(BASE, "INSERT INTO users VALUES (1, 'x');").safety).not.toBe("unsafe")
	})
})
