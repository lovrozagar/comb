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
	"CREATE INDEX orders_expr ON orders ((id + 1));",
	"CREATE VIEW v_users AS SELECT id, n FROM users;",
	"CREATE VIEW v_both AS SELECT u.id FROM v_users u JOIN orders o ON o.user_id = u.id JOIN users x ON x.id = u.id;",
	"CREATE MATERIALIZED VIEW mv AS SELECT id FROM users;",
	"CREATE DOMAIN posint AS int;",
	"CREATE TABLE dm (id int, v posint);",
	"CREATE TABLE ev (id int, at date) PARTITION BY RANGE (at);",
	"CREATE TABLE ev_old PARTITION OF ev FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
	"CREATE TABLE ev_rest PARTITION OF ev DEFAULT;",
	"CREATE TABLE ev_loose (id int, at date);",
	"CREATE TABLE notes (id int, body text);",
	"CREATE TABLE tags (id int, names int[]);",
	"CREATE TABLE stamps (id serial, at pg_catalog.timestamptz);",
	"CREATE SCHEMA s;",
	"CREATE TABLE s.a (id int);",
	"CREATE INDEX ev_i ON ONLY ev (id);",
	"CREATE INDEX ev_old_i ON ev_old (id);",
].join("\n")

const VALIDATE = "ALTER TABLE users VALIDATE CONSTRAINT pos;"

/** What comb says the file holds when `first` runs before VALIDATE in it; "" when it warns of none */
function holds(first: string): string {
	const rated = classifyMigration(`${first}\n${VALIDATE}\n`, {
		before: extractSchema(HISTORY, undefined, "postgres"),
		dialect: "postgres",
	})
	const warning = rated.lockWarnings.find((each) => each.startsWith(`${VALIDATE.slice(0, -1)} (`))
	const said = warning?.match(/while (.*); those locks last to the file's COMMIT/)?.[1] ?? ""
	return said.replace(/^this file holds /, "")
}

/* what comb says of a lock it cannot name, which only the replay measures */
const ONLY_CHECK = "which only check on a postgres:// devUrl names"

/** What comb says of a DROP … CASCADE of `objects`, whose dependents the history's text does not show, and of `others` */
const unnamed = (objects: string, others?: string): string =>
	`this file's DROP … CASCADE locks what depends on ${objects}${others === undefined ? "" : `, and this file also locks ${others}`}, ${ONLY_CHECK}`

/** What comb says of `others`, what the file locks that the history's text does not name, with no DROP … CASCADE */
const locks = (others: string): string => `this file locks ${others}, ${ONLY_CHECK}`

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
	["DROP TABLE ev;", `ev, ev_old and ev_rest locked against reads and writes, and ${locks("the sequences ev owns")}`],
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
	["ALTER TABLE ev RENAME TO events;", "events locked against reads and writes"],
	/* a domain's scans, and a CASCADE drop of a type, on each table with a column of it */
	["ALTER DOMAIN posint ADD CONSTRAINT p CHECK (VALUE > 0);", "dm locked against writes"],
	["ALTER DOMAIN posint VALIDATE CONSTRAINT p;", "dm locked against writes"],
	["DROP DOMAIN posint CASCADE;", `dm locked against reads and writes, and ${unnamed("posint")}`],
	/* each statement family, on the relation it names */
	["CREATE POLICY p ON orders USING (true);", "orders locked against reads and writes"],
	["ALTER POLICY p ON orders USING (false);", "orders locked against reads and writes"],
	["CLUSTER orders USING orders_user;", "orders locked against reads and writes"],
	["TRUNCATE ev;", "ev, ev_old and ev_rest locked against reads and writes"],
	["CREATE RULE r AS ON INSERT TO orders DO INSTEAD NOTHING;", "orders locked against reads and writes"],
	["CREATE TRIGGER t2 AFTER UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trg();", "orders locked against writes"],
	["DROP INDEX orders_user;", "orders locked against reads and writes"],
	["DROP TRIGGER t ON orders;", "orders locked against reads and writes"],
	["CREATE OR REPLACE VIEW v_users AS SELECT id, n FROM users;", "v_users locked against reads and writes"],
	["ALTER TABLE orders DISABLE TRIGGER ALL;", "orders locked against writes"],
	[
		"ALTER TABLE orders ADD COLUMN u int REFERENCES users (id);",
		"orders locked against reads and writes, and users against writes",
	],
	/*
	 * a REINDEX holds each index it rebuilds ACCESS EXCLUSIVE, a TOAST table's among them, which a
	 * column not stored plain gives a table; a table with neither is held SHARE alone
	 */
	["REINDEX TABLE orders;", "orders locked against reads and writes"],
	["REINDEX INDEX orders_user;", "orders locked against reads and writes"],
	["REINDEX TABLE notes;", "notes locked against reads and writes"],
	["REINDEX TABLE tags;", "tags locked against reads and writes"],
	["REINDEX TABLE stamps;", "stamps locked against writes"],
	["REINDEX TABLE ev_loose;", "ev_loose locked against writes"],
	["REINDEX TABLE nowhere;", "nowhere locked against reads and writes"],
	/* an index moved to another tablespace, and a relation to another schema */
	["ALTER INDEX orders_user SET TABLESPACE pg_default;", "orders locked against reads and writes"],
	["ALTER INDEX ev_i ATTACH PARTITION ev_old_i;", "ev_old locked against reads and writes"],
	["ALTER TABLE orders SET SCHEMA s;", "s.orders locked against reads and writes"],
	["ALTER VIEW v_users SET SCHEMA s;", "s.v_users locked against reads and writes"],
	["ALTER MATERIALIZED VIEW mv SET SCHEMA s;", "s.mv locked against reads and writes"],
	/* EXCLUSIVE, which readers pass */
	["REFRESH MATERIALIZED VIEW CONCURRENTLY mv;", "mv locked against writes"],
	/*
	 * AE2-3 of r22: a sequence, the relation another session's nextval waits on, by the name it has
	 * next; the history's sequences are not read, so one IF EXISTS names is held as a missing table is
	 */
	["ALTER SEQUENCE s RESTART;", "s locked against writes"],
	["ALTER SEQUENCE s OWNED BY orders.id;", "s locked against writes"],
	["ALTER SEQUENCE IF EXISTS s SET LOGGED;", "s locked against reads and writes"],
	["ALTER SEQUENCE s OWNER TO CURRENT_USER;", "s locked against reads and writes"],
	["ALTER SEQUENCE IF EXISTS s RENAME TO s2;", "s2 locked against reads and writes"],
	["ALTER SEQUENCE s SET SCHEMA s;", "s.s locked against reads and writes"],
	["DROP SEQUENCE IF EXISTS s;", "s locked against reads and writes"],
	["CREATE SEQUENCE IF NOT EXISTS s;\nALTER SEQUENCE s RESTART;", "s locked against writes"],
	/*
	 * a DROP … CASCADE, of any object, drops what depends on it, a default, a policy's or a view's
	 * expression among them, and locks their tables, which the history's text does not show
	 */
	["DROP SEQUENCE IF EXISTS s CASCADE;", `s locked against reads and writes, and ${unnamed("s")}`],
	[
		"DROP TABLE orders CASCADE;",
		`orders locked against reads and writes, and ${unnamed("orders", "the sequences orders owns")}`,
	],
	["DROP FUNCTION trg() CASCADE;", unnamed("trg")],
	["DROP SCHEMA s, s9 CASCADE;", unnamed("s and s9")],
	[
		"DROP EXTENSION IF EXISTS citext CASCADE;\nDROP CAST (int AS posint) CASCADE;",
		unnamed("(int4 AS posint) and citext"),
	],
	["DROP TRIGGER t ON orders CASCADE;", `orders locked against reads and writes, and ${unnamed("t on orders")}`],
	[
		"ALTER TABLE orders DROP COLUMN user_id CASCADE;",
		`orders locked against reads and writes, and ${unnamed("orders.user_id")}`,
	],
	["ALTER TABLE users DROP CONSTRAINT k CASCADE;", `it locked against reads and writes, and ${unnamed("k on users")}`],
	/*
	 * a DROP of a table, or of a column that owns a sequence, serial, identity or OWNED BY, drops the
	 * sequence without CASCADE, and a column the history does not show may own one
	 */
	[
		"DROP TABLE IF EXISTS notes, s.a;",
		`notes and s.a locked against reads and writes, and ${locks("the sequences notes owns and the sequences s.a owns")}`,
	],
	[
		"ALTER TABLE stamps DROP COLUMN id;",
		`stamps locked against reads and writes, and ${locks("the sequences stamps owns")}`,
	],
	["ALTER TABLE stamps DROP COLUMN at;", "stamps locked against reads and writes"],
	[
		"ALTER FOREIGN TABLE ghost DROP COLUMN x;",
		`ghost locked against reads and writes, and ${locks("the sequences ghost owns")}`,
	],
	[
		"ALTER TABLE notes ADD COLUMN k int GENERATED ALWAYS AS IDENTITY;\nALTER TABLE notes DROP COLUMN k;",
		`notes locked against reads and writes, and ${locks("the sequences notes owns")}`,
	],
	[
		"ALTER TABLE notes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;\nALTER TABLE notes DROP COLUMN id;",
		`notes locked against reads and writes, and ${locks("the sequences notes owns")}`,
	],
	[
		"CREATE SEQUENCE os OWNED BY notes.id;\nALTER TABLE notes DROP COLUMN id;",
		`notes locked against reads and writes, and ${locks("the sequences notes owns")}`,
	],
	[
		"ALTER TABLE stamps ALTER COLUMN id TYPE bigint;\nALTER TABLE stamps RENAME COLUMN id TO sid;\nALTER TABLE stamps DROP COLUMN sid;",
		`stamps locked against reads and writes, and ${locks("the sequences stamps owns")}`,
	],
	[
		"ALTER SEQUENCE nowhere OWNED BY NONE;\nALTER TABLE notes DROP COLUMN body;",
		"notes locked against reads and writes, and nowhere against writes",
	],
	[
		"CREATE TABLE fresh (id serial);\nDROP TABLE fresh;\nALTER TABLE notes DROP COLUMN body;",
		"notes locked against reads and writes",
	],
	/* a DROP or REASSIGN OWNED drops or alters every object its roles own, which neither the history nor check's replay shows */
	[
		"DROP OWNED BY app, CURRENT_USER;",
		"this file locks everything CURRENT_USER owns and everything app owns, which comb cannot name",
	],
	["REASSIGN OWNED BY app TO CURRENT_USER;", "this file locks everything app owns, which comb cannot name"],
	[
		"DROP TABLE ev_loose;\nDROP OWNED BY app;",
		`ev_loose locked against reads and writes, and ${locks("the sequences ev_loose owns")}, and this file also locks everything app owns, which comb cannot name`,
	],
	/* an ALTER TYPE … CASCADE rewrites each table made OF the type, which the history does not show */
	["ALTER TYPE pair RENAME ATTRIBUTE a TO c CASCADE;", locks("the tables of type pair")],
	[
		"ALTER TYPE pair ADD ATTRIBUTE z int CASCADE, ALTER ATTRIBUTE a TYPE bigint CASCADE;",
		locks("the tables of type pair"),
	],
	["ALTER TYPE s.pair DROP ATTRIBUTE z CASCADE;", unnamed("s.pair.z", "the tables of type s.pair")],
]

/* statements that leave nothing held */
const NOTHING: string[] = [
	/* what takes SHARE UPDATE EXCLUSIVE or weaker, and what cannot run in a transaction */
	"LOCK orders IN SHARE UPDATE EXCLUSIVE MODE;",
	"ALTER DOMAIN posint ADD CONSTRAINT p CHECK (VALUE > 0) NOT VALID;",
	"ALTER DOMAIN posint SET DEFAULT 1;",
	"DROP DOMAIN posint;",
	"DROP INDEX nowhere;",
	"REINDEX INDEX nowhere;",
	"ALTER INDEX orders_user SET (fillfactor = 70);",
	"ALTER INDEX orders_user RENAME TO orders_u;",
	"ALTER INDEX orders_expr ALTER COLUMN 1 SET STATISTICS 100;",
	"ALTER INDEX nowhere SET TABLESPACE pg_default;",
	"ALTER INDEX ev_i ATTACH PARTITION nowhere;",
	"ALTER FUNCTION trg() SET SCHEMA s;",
	"ALTER TYPE posint SET SCHEMA s;",
	"ALTER TYPE pair ADD ATTRIBUTE z int;",
	"ALTER TYPE pair RENAME ATTRIBUTE a TO c;",
	/* a temporary table, and a relation the file made, which no other session sees */
	"CREATE TEMP TABLE tt (id int);\nALTER TABLE tt ADD COLUMN x int;",
	"LOCK TABLE pg_temp.tt;",
	"CREATE VIEW v_new AS SELECT 1 AS one;\nALTER VIEW v_new ALTER COLUMN one SET DEFAULT 2;",
	"CREATE TABLE t AS SELECT 1 AS one;\nALTER TABLE t ADD COLUMN x int;",
	"SELECT 1 AS one INTO t;\nALTER TABLE t ADD COLUMN x int;",
	"CREATE MATERIALIZED VIEW mv2 AS SELECT 1 AS one;\nREFRESH MATERIALIZED VIEW mv2;",
	"CREATE TABLE t (id int);\nALTER TABLE t RENAME TO t2;\nALTER TABLE t2 ADD COLUMN x int;",
	"CREATE TABLE t (id int);\nALTER TABLE t RENAME COLUMN id TO num;\nALTER TABLE t ADD COLUMN x int;",
	"CREATE SEQUENCE sq;\nALTER SEQUENCE sq RENAME TO sq2;\nALTER SEQUENCE sq2 RESTART;",
	"CREATE TEMP SEQUENCE tsq;\nALTER SEQUENCE tsq RESTART;",
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

	it("holds a relation the history holds through its schema's rename, by its schema's new name", () => {
		expect(holds("ALTER TABLE s.a ADD COLUMN x int;\nALTER SCHEMA s RENAME TO s3;")).toBe(
			"s3.a locked against reads and writes",
		)
		expect(
			holds("CREATE TRIGGER t9 AFTER UPDATE ON s.a FOR EACH ROW EXECUTE FUNCTION trg();\nALTER SCHEMA s RENAME TO s3;"),
		).toBe("s3.a locked against writes")
		expect(holds("CREATE TABLE s.t (id int);\nALTER SCHEMA s RENAME TO s3;\nALTER TABLE s3.t ADD COLUMN x int;")).toBe(
			"",
		)
		expect(holds("ALTER TABLE orders ADD COLUMN x int;\nALTER SCHEMA s RENAME TO s3;")).toBe(
			"orders locked against reads and writes",
		)
	})

	it("holds a relation the history holds through its move to another schema, by its new name alone", () => {
		expect(holds("ALTER TABLE orders SET SCHEMA s;\nALTER TABLE s.orders ADD COLUMN x int;")).toBe(
			"s.orders locked against reads and writes",
		)
		expect(holds("CREATE TABLE t (id int);\nALTER TABLE t SET SCHEMA s;\nALTER TABLE s.t ADD COLUMN x int;")).toBe("")
	})

	it("holds a relation the history holds through its rename by its new name alone, and one renamed in a schema by its schema", () => {
		expect(holds("ALTER TABLE orders RENAME TO o2;\nALTER TABLE o2 ADD COLUMN x int;")).toBe(
			"o2 locked against reads and writes",
		)
		expect(holds("ALTER TABLE s.a ADD COLUMN x int;\nALTER TABLE s.a RENAME TO c;")).toBe(
			"s.c locked against reads and writes",
		)
		expect(holds("CREATE TABLE s.t (id int);\nALTER TABLE s.t RENAME TO t2;\nALTER TABLE s.t2 ADD COLUMN x int;")).toBe(
			"",
		)
	})
})

describe("what a DROP … CASCADE leaves held", () => {
	it("holds no DROP … CASCADE past the COMMIT of its transaction", () => {
		const rated = classifyMigration(
			`-- atlas:txmode none\n\nBEGIN;\nDROP FUNCTION trg() CASCADE;\nCOMMIT;\nBEGIN;\nLOCK orders;\n${VALIDATE}\nCOMMIT;\n`,
			{ before: extractSchema(HISTORY, undefined, "postgres"), dialect: "postgres" },
		)
		expect(rated.lockWarnings.filter((each) => each.startsWith(`${VALIDATE.slice(0, -1)} (`))).toEqual([
			`${VALIDATE.slice(0, -1)} (scans users while this file holds orders locked against reads and writes; those locks last to the file's COMMIT; validate in a later file)`,
		])
	})
})
