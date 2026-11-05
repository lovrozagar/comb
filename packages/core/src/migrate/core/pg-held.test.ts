/**
 * The locks a Postgres file's open transaction holds to its COMMIT (0005 of r22b), read through the
 * VALIDATE that scans under them: each case is a statement, then a VALIDATE, in one file, and what
 * comb says the file holds at the VALIDATE. tests/integration/postgres/lock-oracle-held.test.ts holds
 * the lock of each statement family to Postgres 17's own pg_locks; these hold the ways a statement
 * reaches past the relation it names, and the statements that take none.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(loadPostgresParser)

const HISTORY = [
	"CREATE TABLE users (id int PRIMARY KEY, n int);",
	"ALTER TABLE users ADD CONSTRAINT pos CHECK (n > 0) NOT VALID;",
	"CREATE TABLE orders (id int, user_id int);",
	"CREATE INDEX orders_user ON orders (user_id);",
	"CREATE VIEW v_users AS SELECT id, n FROM users;",
	"CREATE VIEW v_both AS SELECT u.id FROM v_users u JOIN orders o ON o.user_id = u.id JOIN users x ON x.id = u.id;",
	"CREATE MATERIALIZED VIEW mv AS SELECT id FROM users;",
	"CREATE DOMAIN posint AS int;",
	"CREATE TABLE dm (id int, v posint);",
	"CREATE TABLE ev (id int, at date) PARTITION BY RANGE (at);",
	"CREATE TABLE ev_old PARTITION OF ev FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
	"CREATE TABLE ev_rest PARTITION OF ev DEFAULT;",
	"CREATE TABLE ev_loose (id int, at date);",
].join("\n")

const VALIDATE = "ALTER TABLE users VALIDATE CONSTRAINT pos;"

/** What comb says the file holds when `first` runs before VALIDATE in it; "" when it warns of none */
function holds(first: string): string {
	const rated = classifyMigration(`${first}\n${VALIDATE}\n`, {
		before: extractSchema(HISTORY, undefined, "postgres"),
		dialect: "postgres",
	})
	const warning = rated.lockWarnings.find((each) => each.startsWith(`${VALIDATE.slice(0, -1)} (`))
	return warning?.match(/while this file holds (.*); those locks last to the file's COMMIT/)?.[1] ?? ""
}

/* each statement before the VALIDATE, and what comb says the file then holds */
const HOLDS: Array<[string, string]> = [
	/* through a view to every relation its query reads, a view's included, users by two paths */
	["LOCK v_both IN SHARE MODE;", "orders, users, v_both and v_users locked against writes"],
	["LOCK ONLY ev IN ACCESS EXCLUSIVE MODE;", "ev locked against reads and writes"],
	["LOCK ev;", "ev, ev_old and ev_rest locked against reads and writes"],
	/* a partition's DEFAULT sibling, which its bound is checked against */
	["ALTER TABLE ev DETACH PARTITION ev_old;", "ev, ev_old and ev_rest locked against reads and writes"],
	[
		"ALTER TABLE ev ATTACH PARTITION ev_loose FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');",
		"ev_loose and ev_rest locked against reads and writes",
	],
	[
		"CREATE TABLE ev_new PARTITION OF ev FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');",
		"ev and ev_rest locked against reads and writes",
	],
	/* a partitioned table's index, built and dropped through it */
	["CREATE INDEX ev_at ON ev (at);", "ev, ev_old and ev_rest locked against writes"],
	["CREATE INDEX ev_at ON ONLY ev (at);", "ev locked against writes"],
	["DROP TABLE ev;", "ev, ev_old and ev_rest locked against reads and writes"],
	/* a view's options, any of them, and a table's user_catalog_table alone */
	["ALTER VIEW v_users SET (security_barrier = true);", "v_users locked against reads and writes"],
	["ALTER TABLE orders RESET (fillfactor);", ""],
	["ALTER TABLE orders RESET (user_catalog_table);", "orders locked against reads and writes"],
	/* a foreign key, whatever declares it, and a self-reference in a table the file makes */
	[
		"ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id);",
		"orders and users locked against writes",
	],
	[
		"CREATE TABLE t (id int PRIMARY KEY, up int REFERENCES t (id), FOREIGN KEY (id) REFERENCES orders (id));",
		"orders locked against writes",
	],
	/* a column rename through the descendants, a table's alone */
	["ALTER TABLE ev RENAME COLUMN at TO day;", "ev, ev_old and ev_rest locked against reads and writes"],
	["ALTER TABLE ev RENAME TO events;", "ev locked against reads and writes"],
	/* a domain's scans, and a CASCADE drop of a type, on each table with a column of it */
	["ALTER DOMAIN posint ADD CONSTRAINT p CHECK (VALUE > 0);", "dm locked against writes"],
	["ALTER DOMAIN posint VALIDATE CONSTRAINT p;", "dm locked against writes"],
	["DROP DOMAIN posint CASCADE;", "dm locked against reads and writes"],
	/* each statement family, on the relation it names */
	["CREATE POLICY p ON orders USING (true);", "orders locked against reads and writes"],
	["ALTER POLICY p ON orders USING (false);", "orders locked against reads and writes"],
	["CLUSTER orders USING orders_user;", "orders locked against reads and writes"],
	["TRUNCATE ev;", "ev, ev_old and ev_rest locked against reads and writes"],
	["CREATE RULE r AS ON INSERT TO orders DO INSTEAD NOTHING;", "orders locked against reads and writes"],
	["REINDEX TABLE orders;", "orders locked against writes"],
	["CREATE TRIGGER t2 AFTER UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trg();", "orders locked against writes"],
	["REINDEX INDEX orders_user;", "orders locked against writes"],
	["DROP INDEX orders_user;", "orders locked against reads and writes"],
	["DROP TRIGGER t ON orders;", "orders locked against reads and writes"],
	["CREATE OR REPLACE VIEW v_users AS SELECT id, n FROM users;", "v_users locked against reads and writes"],
	["ALTER TABLE orders DISABLE TRIGGER ALL;", "orders locked against writes"],
	[
		"ALTER TABLE orders ADD COLUMN u int REFERENCES users (id);",
		"orders locked against reads and writes, and users against writes",
	],
	/* EXCLUSIVE, which readers pass */
	["REFRESH MATERIALIZED VIEW CONCURRENTLY mv;", "mv locked against writes"],
]

/* statements that leave nothing held */
const NOTHING: string[] = [
	/* what takes SHARE UPDATE EXCLUSIVE or weaker, and what cannot run in a transaction */
	"LOCK orders IN SHARE UPDATE EXCLUSIVE MODE;",
	"ALTER DOMAIN posint ADD CONSTRAINT p CHECK (VALUE > 0) NOT VALID;",
	"ALTER DOMAIN posint SET DEFAULT 1;",
	"DROP DOMAIN posint;",
	"DROP INDEX nowhere;",
	"DROP SEQUENCE IF EXISTS s;",
	"REINDEX INDEX nowhere;",
	"ALTER INDEX orders_user SET (fillfactor = 70);",
	"ALTER INDEX orders_user RENAME TO orders_u;",
	"ALTER SEQUENCE IF EXISTS s RENAME TO s2;",
	/* a temporary table, and a relation the file made, which no other session sees */
	"CREATE TEMP TABLE tt (id int);\nALTER TABLE tt ADD COLUMN x int;",
	"LOCK TABLE pg_temp.tt;",
	"CREATE VIEW v_new AS SELECT 1 AS one;\nALTER VIEW v_new ALTER COLUMN one SET DEFAULT 2;",
	"CREATE TABLE t AS SELECT 1 AS one;\nALTER TABLE t ADD COLUMN x int;",
	"SELECT 1 AS one INTO t;\nALTER TABLE t ADD COLUMN x int;",
	"CREATE MATERIALIZED VIEW mv2 AS SELECT 1 AS one;\nREFRESH MATERIALIZED VIEW mv2;",
	"CREATE TABLE t (id int);\nALTER TABLE t RENAME TO t2;\nALTER TABLE t2 ADD COLUMN x int;",
	"CREATE TABLE t (id int);\nALTER TABLE t RENAME COLUMN id TO num;\nALTER TABLE t ADD COLUMN x int;",
]

describe("what a statement before a VALIDATE leaves held (0005)", () => {
	it.each(HOLDS)("%s holds %s", (first, held) => {
		expect(holds(first)).toBe(held)
	})

	it.each(NOTHING)("%s holds nothing", (first) => {
		expect(holds(first)).toBe("")
	})

	it("holds nothing past a statement only a txmode none file runs, which commits it", () => {
		expect(
			holds(
				"-- atlas:txmode none\n\nREINDEX SCHEMA public;\nCLUSTER;\nCREATE INDEX CONCURRENTLY orders_id ON orders (id);",
			),
		).toBe("")
	})

	it("holds what a table the history holds takes, though the file wrote CREATE IF NOT EXISTS of it", () => {
		expect(holds("CREATE TABLE IF NOT EXISTS orders (id int);\nALTER TABLE orders ADD COLUMN x int;")).toBe(
			"orders locked against reads and writes",
		)
	})

	it("holds a relation the history holds through its rename, and one renamed in a schema by its schema", () => {
		expect(holds("ALTER TABLE orders RENAME TO o2;\nALTER TABLE o2 ADD COLUMN x int;")).toBe(
			"o2 and orders locked against reads and writes",
		)
		expect(holds("CREATE TABLE s.t (id int);\nALTER TABLE s.t RENAME TO t2;\nALTER TABLE s.t2 ADD COLUMN x int;")).toBe(
			"",
		)
	})
})
