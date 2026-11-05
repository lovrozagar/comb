/**
 * A VALIDATE after any statement of its transaction that holds a strong lock (0005, the class of PA8
 * of r22b). A VALIDATE alone takes SHARE UPDATE EXCLUSIVE and blocks nothing, but every lock an earlier
 * statement of the file took lasts to its COMMIT, so the VALIDATE's scan of every row runs under it.
 * Each case runs a statement, then the VALIDATE, as Atlas runs a file, in one transaction, reads what
 * the transaction holds from pg_locks, and holds comb's warning of the VALIDATE to it: comb warns
 * exactly when Postgres holds a lock that blocks reads or writes of a relation another session sees,
 * and names the relations it holds as Postgres does.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { withScratchDb } from "../support/pg.ts"
import { heldBy } from "../support/pg-locks.ts"

beforeAll(loadPostgresParser)

const HISTORY = [
	"CREATE TABLE users (id int PRIMARY KEY, n int);",
	"CREATE TABLE orders (id int, user_id int);",
	"CREATE INDEX orders_user ON orders (user_id);",
	"CREATE VIEW v_users AS SELECT id, n FROM users;",
	"CREATE MATERIALIZED VIEW mv AS SELECT id FROM users;",
	"CREATE FUNCTION trg() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;",
	"CREATE TRIGGER t_orders AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION trg();",
	"CREATE POLICY p_orders ON orders USING (true);",
	"CREATE RULE r_orders AS ON DELETE TO orders DO ALSO NOTHING;",
	"CREATE DOMAIN posint AS int;",
	"CREATE TABLE dm (id int, v posint);",
	"CREATE TABLE ev (id int NOT NULL, at date NOT NULL) PARTITION BY RANGE (at);",
	"CREATE TABLE ev_old PARTITION OF ev FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
	"CREATE TABLE ev_loose (id int NOT NULL, at date NOT NULL);",
	"ALTER TABLE users ADD CONSTRAINT pos CHECK (n > 0) NOT VALID;",
].join("\n")

const VALIDATE = "ALTER TABLE users VALIDATE CONSTRAINT pos;"
const HELD = "those locks last to the file's COMMIT; validate in a later file"
const [READS, WRITES] = ["reads and writes", "writes"]

/** "a", "a and b", "a, b and c" */
const listed = (names: readonly string[]): string =>
	names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) as string}`

/** comb's warning of the VALIDATE when its file holds `held`, as Postgres reports it; none when it holds nothing */
function warningOf(held: Readonly<Record<string, string>>): string[] {
	const names = Object.keys(held).toSorted()
	if (names.length === 0) return []
	const by = (blocks: string) => names.filter((name) => held[name] === blocks)
	const [reads, writes] = [by(READS), by(WRITES)]
	const holding =
		names.length === 1 && names[0] === "users"
			? `it locked against ${held["users"] as string}`
			: [
					...(reads.length > 0 ? [`${listed(reads)} locked against reads and writes`] : []),
					...(writes.length > 0 ? [`${listed(writes)}${reads.length > 0 ? "" : " locked"} against writes`] : []),
				].join(", and ")
	return [`${VALIDATE.slice(0, -1)} (scans users while this file holds ${holding}; ${HELD})`]
}

/** comb's warnings of the VALIDATE after `first`, in its file */
const validateWarnings = (first: string): string[] =>
	classifyMigration(`${first}\n${VALIDATE}\n`, {
		before: extractSchema(HISTORY, undefined, "postgres"),
		dialect: "postgres",
	}).lockWarnings.filter((warning) => warning.startsWith(`${VALIDATE.slice(0, -1)} (`))

// lookup-table: each statement before the VALIDATE, with what Postgres 17 holds blocked at the file's end
const CASES: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
	/* comb-5d's red: an ADD COLUMN, then a CREATE INDEX */
	["ALTER TABLE users ADD COLUMN x int;", { users: READS }],
	["CREATE INDEX orders_id ON orders (id);", { orders: WRITES }],
	/* ALTER TABLE, command by command */
	[
		"ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;",
		{ orders: WRITES, users: WRITES },
	],
	["ALTER TABLE orders ADD COLUMN u int REFERENCES users (id);", { orders: READS, users: WRITES }],
	["ALTER TABLE orders ENABLE TRIGGER t_orders;", { orders: WRITES }],
	["ALTER TABLE orders DISABLE RULE r_orders;", { orders: READS }],
	["ALTER TABLE orders SET (fillfactor = 70), ALTER COLUMN id SET STATISTICS 100, CLUSTER ON orders_user;", {}],
	["ALTER TABLE orders SET (user_catalog_table = true);", { orders: READS }],
	["ALTER TABLE orders RENAME COLUMN id TO num;", { orders: READS }],
	["ALTER TABLE orders RENAME TO orders2;", { orders: READS }],
	["ALTER TABLE ev ADD COLUMN x int;", { ev: READS, ev_old: READS }],
	["ALTER TABLE ev ATTACH PARTITION ev_loose FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');", { ev_loose: READS }],
	["ALTER TABLE ev DETACH PARTITION ev_old;", { ev: READS, ev_old: READS }],
	["ALTER VIEW v_users ALTER COLUMN n SET DEFAULT 0;", { v_users: READS }],
	["ALTER MATERIALIZED VIEW mv SET TABLESPACE pg_default;", { mv: READS }],
	/* a table the file makes, which no other session sees, and the tables it references */
	["CREATE TABLE t_new (id int);\nALTER TABLE t_new ADD COLUMN y int;", {}],
	["CREATE TABLE t_new (id int REFERENCES users (id));", { users: WRITES }],
	["CREATE TABLE ev_new PARTITION OF ev FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');", { ev: READS }],
	/* triggers, rules and policies */
	["CREATE TRIGGER t2 AFTER UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trg();", { orders: WRITES }],
	["ALTER TRIGGER t_orders ON orders RENAME TO t3;", { orders: READS }],
	["DROP TRIGGER t_orders ON orders;", { orders: READS }],
	["CREATE RULE r AS ON INSERT TO orders DO INSTEAD NOTHING;", { orders: READS }],
	["CREATE POLICY p2 ON orders USING (true);", { orders: READS }],
	["ALTER POLICY p_orders ON orders USING (false);", { orders: READS }],
	["DROP POLICY p_orders ON orders;", { orders: READS }],
	["ALTER POLICY p_orders ON orders RENAME TO p3;", { orders: READS }],
	["ALTER RULE r_orders ON orders RENAME TO r3;", { orders: READS }],
	/* LOCK, by its mode; a view's reaches its table */
	["LOCK orders IN SHARE MODE;", { orders: WRITES }],
	["LOCK orders IN ROW EXCLUSIVE MODE;", {}],
	["LOCK orders;", { orders: READS }],
	["LOCK v_users IN SHARE MODE;", { users: WRITES, v_users: WRITES }],
	/* maintenance */
	["TRUNCATE orders;", { orders: READS }],
	["REFRESH MATERIALIZED VIEW mv;", { mv: READS }],
	["CLUSTER orders USING orders_user;", { orders: READS }],
	["REINDEX TABLE orders;", { orders: WRITES }],
	["REINDEX INDEX orders_user;", { orders: WRITES }],
	/* drops */
	["DROP INDEX orders_user;", { orders: READS }],
	["DROP TABLE orders;", { orders: READS }],
	["DROP VIEW v_users;", { v_users: READS }],
	["DROP DOMAIN posint CASCADE;", { dm: READS }],
	["CREATE OR REPLACE VIEW v_users AS SELECT id, n FROM users;", { v_users: READS }],
	["ALTER DOMAIN posint SET NOT NULL;", { dm: WRITES }],
	/* what blocks nothing */
	["COMMENT ON TABLE orders IS 'x';", {}],
	["GRANT SELECT ON orders TO PUBLIC;", {}],
	["CREATE STATISTICS st ON id, user_id FROM orders;", {}],
	["ALTER INDEX orders_user RENAME TO orders_u;", {}],
	["UPDATE orders SET id = 0;", {}],
]

describe("a VALIDATE after a statement of its file that holds a strong lock on Postgres 17 (0005; sibling: PA8's NOT VALID ADD)", () => {
	it.each(CASES)(
		"after %s, warns exactly when Postgres holds a blocking lock, naming what it holds",
		async (first, held) => {
			await withScratchDb(async (url) => {
				expect(await heldBy(url, [HISTORY], `${first}\n${VALIDATE}\n`)).toEqual(held)
			})
			expect(validateWarnings(first)).toEqual(warningOf(held))
		},
		60_000,
	)
})
