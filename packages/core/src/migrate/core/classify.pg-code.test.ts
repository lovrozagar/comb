/**
 * M73 of the 0.13.0 round: code the history attaches to a table runs on a later plain write or
 * DDL, so the history reader records it wherever Postgres runs it: a domain CHECK added later or
 * inherited from a base domain, a column retyped to such a domain, an inheritance parent's
 * defaults and checks, every policy's predicate, and an event trigger on every later DDL.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const BASE = `CREATE TABLE victim (id int PRIMARY KEY);
CREATE FUNCTION wipe() RETURNS int LANGUAGE plpgsql AS $$ BEGIN DELETE FROM victim; RETURN 1; END $$;
CREATE FUNCTION wipe_b() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN DELETE FROM victim; RETURN true; END $$;
CREATE FUNCTION wipe_evt() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM victim; END $$;`

/** `later`'s rating and unsafe notes after BASE and `history`, read as Postgres */
function rate(history: string, later: string) {
	const before = extractSchema(`${BASE} ${history}`, undefined, "postgres")
	const result = classifyMigration(later, { before, dialect: "postgres" })
	return { notes: result.unsafeStatements.join(" "), safety: result.safety }
}

describe("a domain's code, wherever the history gives it (M73)", () => {
	it("runs a CHECK added to the domain after the table took it", () => {
		const history = "CREATE DOMAIN d AS int; CREATE TABLE t (v d); ALTER DOMAIN d ADD CONSTRAINT c CHECK (wipe_b());"
		expect(rate(history, "INSERT INTO t VALUES (1);").notes).toContain("runs wipe_b on every write to t")
	})

	it("keeps the domain's first code when another CHECK is added, and ignores a pure one", () => {
		const history =
			"CREATE DOMAIN d AS int CHECK (wipe_b()); CREATE TABLE t (v d); ALTER DOMAIN d ADD CHECK (wipe() > 0); ALTER DOMAIN d ADD CHECK (VALUE > 0);"
		expect(rate(history, "INSERT INTO t VALUES (1);").notes).toContain("runs wipe_b")
	})

	it("runs a base domain's CHECK through a domain over it", () => {
		const history = "CREATE DOMAIN d AS int CHECK (wipe_b()); CREATE DOMAIN d2 AS d; CREATE TABLE t (v d2);"
		expect(rate(history, "INSERT INTO t VALUES (1);").notes).toContain("runs wipe_b")
	})

	it("runs the domain's CHECK on a column retyped to it", () => {
		const history =
			"CREATE DOMAIN d AS int CHECK (wipe_b()); CREATE TABLE t (v int); ALTER TABLE t ALTER COLUMN v TYPE d;"
		expect(rate(history, "INSERT INTO t VALUES (1);").notes).toContain("runs wipe_b")
	})
})

describe("an inheritance parent's code, a policy's predicate, an event trigger (M73)", () => {
	it("runs an inheritance parent's DEFAULT and CHECK on a write to its child", () => {
		const defaults = "CREATE TABLE p (id int, n int DEFAULT wipe()); CREATE TABLE c () INHERITS (p);"
		expect(rate(defaults, "INSERT INTO c (id) VALUES (1);").notes).toContain("runs wipe")
		const checks = "CREATE TABLE p (id int CHECK (wipe_b())); CREATE TABLE c () INHERITS (p);"
		expect(rate(checks, "INSERT INTO c (id) VALUES (1);").notes).toContain("runs wipe_b")
	})

	it("runs a policy's WITH CHECK or USING, forced or not", () => {
		const forced = `CREATE TABLE t (id int); CREATE POLICY p ON t WITH CHECK (wipe_b());
ALTER TABLE t ENABLE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY;`
		expect(rate(forced, "INSERT INTO t VALUES (1);").notes).toContain("runs wipe_b")
		const altered = "CREATE TABLE t (id int); CREATE POLICY p ON t USING (true); ALTER POLICY p ON t USING (wipe_b());"
		expect(rate(altered, "UPDATE t SET id = 2;").notes).toContain("runs wipe_b")
	})

	it("runs an event trigger on every later DDL statement, until it is dropped or disabled", () => {
		const made = "CREATE EVENT TRIGGER e ON ddl_command_end EXECUTE FUNCTION wipe_evt();"
		expect(rate(made, "CREATE TABLE fresh (id int);").notes).toContain("runs event trigger e")
		expect(rate(made, "INSERT INTO victim VALUES (1);").notes).not.toContain("event trigger")
		expect(rate(`${made} DROP EVENT TRIGGER e;`, "CREATE TABLE fresh (id int);").safety).toBe("safe")
		expect(rate(`${made} ALTER EVENT TRIGGER e DISABLE;`, "CREATE TABLE fresh (id int);").safety).toBe("safe")
	})
})

/** An event trigger e on `on`, running wipe_evt */
const trigger = (on: string) => `CREATE EVENT TRIGGER e ON ${on} EXECUTE FUNCTION wipe_evt();`

describe("an event trigger, matched by its event and tags (M73)", () => {
	it("runs a tag-filtered trigger on a statement of a listed tag, and on no other", () => {
		const tagged = trigger("ddl_command_start WHEN TAG IN ('CREATE TABLE', 'ALTER TABLE')")
		expect(rate(tagged, "ALTER TABLE victim ADD COLUMN n int;").notes).toContain("runs event trigger e")
		expect(rate(tagged, "CREATE INDEX i ON victim (id);").notes).not.toContain("event trigger")
	})

	it("runs a sql_drop trigger on a drop, and on nothing that drops none", () => {
		const dropping = trigger("sql_drop")
		expect(rate(dropping, "CREATE TABLE fresh (id int);").notes).not.toContain("event trigger")
		expect(rate(dropping, "DROP INDEX gone;").notes).toContain("runs event trigger e")
		expect(rate(dropping, "ALTER TABLE victim DROP CONSTRAINT c;").notes).toContain("runs event trigger e")
	})

	it("runs a table_rewrite trigger on a command that rewrites a table, and on no other", () => {
		const rewriting = trigger("table_rewrite")
		expect(rate(rewriting, "ALTER TABLE victim ALTER COLUMN id TYPE bigint;").notes).toContain("runs event trigger e")
		expect(rate(rewriting, "ALTER TABLE victim ADD COLUMN n int;").notes).not.toContain("event trigger")
	})

	it("runs a trigger enabled again after a DISABLE, and one renamed under its new name", () => {
		const made = trigger("ddl_command_end")
		expect(
			rate(
				`${made} ALTER EVENT TRIGGER e DISABLE; ALTER EVENT TRIGGER e ENABLE ALWAYS;`,
				"CREATE TABLE fresh (id int);",
			).notes,
		).toContain("runs event trigger e")
		expect(rate(`${made} ALTER EVENT TRIGGER e RENAME TO e2;`, "CREATE TABLE fresh (id int);").notes).toContain(
			"runs event trigger e2",
		)
	})
})

/* a trigger fires only while enabled; ENABLE REPLICA fires only under session_replication_role =
 * replica, which no migration runs with, so it is off, for a table's triggers and an event trigger alike */
describe("a trigger the history disabled or enabled again (M73)", () => {
	const TABLE =
		"CREATE TABLE users (id int); CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe_evt();"

	it("fires a table's trigger while enabled, and not while disabled or set to replica", () => {
		const insert = "INSERT INTO users VALUES (1);"
		expect(rate(`${TABLE} ALTER TABLE users DISABLE TRIGGER t;`, insert).notes).not.toContain("fires trigger")
		expect(rate(`${TABLE} ALTER TABLE users ENABLE REPLICA TRIGGER t;`, insert).notes).not.toContain("fires trigger")
		expect(rate(`${TABLE} ALTER TABLE users DISABLE TRIGGER USER;`, insert).notes).not.toContain("fires trigger")
		expect(
			rate(`${TABLE} ALTER TABLE users DISABLE TRIGGER t; ALTER TABLE users ENABLE ALWAYS TRIGGER t;`, insert).notes,
		).toContain("fires trigger t")
		expect(
			rate(`${TABLE} ALTER TABLE users DISABLE TRIGGER ALL; ALTER TABLE users ENABLE TRIGGER ALL;`, insert).notes,
		).toContain("fires trigger t")
	})

	it("reads a trigger command on a table with no triggers as nothing", () => {
		expect(rate("CREATE TABLE z (id int); ALTER TABLE z ENABLE TRIGGER ALL;", "INSERT INTO z VALUES (1);").safety).toBe(
			"safe",
		)
		/* a command that names another trigger leaves this one as it was */
		expect(rate(`${TABLE} ALTER TABLE users DISABLE TRIGGER other;`, "INSERT INTO users VALUES (1);").notes).toContain(
			"fires trigger t",
		)
	})

	it("keeps an event trigger set to ENABLE REPLICA off", () => {
		const made = trigger("ddl_command_end")
		expect(rate(`${made} ALTER EVENT TRIGGER e ENABLE REPLICA;`, "CREATE TABLE fresh (id int);").safety).toBe("safe")
	})

	it("fires an event trigger a file makes on the file's later DDL, never on its own statement", () => {
		const result = rate("", `${trigger("ddl_command_end")}\nCREATE TABLE fresh (id int);`)
		expect(result.notes).toContain("CREATE TABLE fresh (id int) (runs event trigger e")
		expect(result.notes).not.toMatch(/CREATE EVENT TRIGGER[^)]*\(runs event trigger/)
	})
})

/* session_replication_role = replica flips which triggers fire and turns off foreign key checks */
describe("a file that changes session_replication_role (M73)", () => {
	const DISABLED =
		"CREATE TABLE users (id int); CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe_evt(); ALTER TABLE users DISABLE TRIGGER t;"

	it("rates the SET and the set_config call unsafe, saying what they turn off", () => {
		for (const sql of [
			"SET session_replication_role = replica;",
			"SET LOCAL session_replication_role = replica;",
			"SELECT set_config('session_replication_role', 'replica', true);",
		])
			expect(rate("", sql).notes, sql).toContain("disables foreign key checks and ordinary triggers for the session")
	})

	it("reads a set_config of a setting it cannot read as one, and of another setting as any call", () => {
		expect(rate("", "SELECT set_config(current_user, 'replica', true);").notes).toContain("disables foreign key checks")
		expect(rate("", "SELECT set_config();").notes).toContain("disables foreign key checks")
		expect(rate("", "SELECT set_config('search_path', 'x', true);").notes).toContain("calls set_config")
	})

	it("counts every trigger after it as firing, a disabled table trigger and an event trigger alike", () => {
		const later = "SET session_replication_role = replica;\nINSERT INTO users VALUES (1);"
		expect(rate(DISABLED, later).notes).toContain("fires trigger t")
		const off = `${trigger("ddl_command_end")} ALTER EVENT TRIGGER e DISABLE;`
		expect(rate(off, "SET session_replication_role = replica;\nCREATE TABLE fresh (id int);").notes).toContain(
			"runs event trigger e",
		)
		/* before the SET, the disabled trigger fires on nothing */
		expect(rate(DISABLED, "INSERT INTO users VALUES (1);").notes).not.toContain("fires trigger")
	})
})
