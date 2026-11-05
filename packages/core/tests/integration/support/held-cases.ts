/**
 * The history and the statements before a VALIDATE that lock-oracle-held.test.ts holds comb's
 * held warnings to Postgres 17's pg_locks with, and check-held.test.ts holds check's replay to:
 * each statement with what Postgres holds blocked at its file's end.
 */
import type { Unnamed } from "./pg-locks.ts"

export const HISTORY = [
	"CREATE TABLE users (id int PRIMARY KEY, n int);",
	"CREATE TABLE orders (id int, user_id int);",
	"CREATE INDEX orders_user ON orders (user_id);",
	"CREATE INDEX orders_expr ON orders ((id + 1));",
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
	"CREATE SCHEMA s;",
	"CREATE TABLE pt (id int) PARTITION BY LIST (id);",
	"CREATE TABLE pt_1 PARTITION OF pt FOR VALUES IN (1);",
	"CREATE INDEX pt_i ON ONLY pt (id);",
	"CREATE INDEX pt_1_i ON pt_1 (id);",
	"CREATE SEQUENCE seq;",
	"CREATE TABLE ids (id bigint DEFAULT nextval('seq'));",
	"CREATE SEQUENCE seq_free;",
	"CREATE TABLE serials (id serial, n int);",
	"CREATE TYPE pr AS (a int, b int);",
	"CREATE TABLE typed OF pr;",
	"ALTER TABLE users ADD CONSTRAINT pos CHECK (n > 0) NOT VALID;",
].join("\n")

export const VALIDATE = "ALTER TABLE users VALIDATE CONSTRAINT pos;"
const [READS, WRITES] = ["reads and writes", "writes"]

// lookup-table: each statement before the VALIDATE, with what Postgres 17 holds blocked at the file's end
export const CASES: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
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
	["ALTER TABLE orders RENAME TO orders2;", { orders2: READS }],
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
	/* a REINDEX holds each index it rebuilds ACCESS EXCLUSIVE, which every query of its table opens */
	["REINDEX TABLE orders;", { orders: READS }],
	["REINDEX INDEX orders_user;", { orders: READS }],
	["REINDEX TABLE users;", { users: READS }],
	/* an index's own ALTER: a move rewrites it under ACCESS EXCLUSIVE; its options take SHARE UPDATE EXCLUSIVE */
	["ALTER INDEX orders_user SET TABLESPACE pg_default;", { orders: READS }],
	["ALTER INDEX orders_user SET (fillfactor = 50);", {}],
	["ALTER INDEX orders_expr ALTER COLUMN 1 SET STATISTICS 100;", {}],
	/* an index attached to a partitioned table's, held ACCESS EXCLUSIVE, which every query of its partition opens */
	["ALTER INDEX pt_i ATTACH PARTITION pt_1_i;", { pt_1: READS }],
	/* a move to another schema, read by the name the table has after it */
	["ALTER TABLE orders SET SCHEMA s;", { "s.orders": READS }],
	["ALTER VIEW v_users SET SCHEMA s;", { "s.v_users": READS }],
	/* drops */
	["DROP INDEX orders_user;", { orders: READS }],
	["DROP TABLE orders;", { orders: READS }],
	["DROP VIEW v_users;", { v_users: READS }],
	["DROP DOMAIN posint CASCADE;", { dm: READS }],
	["CREATE OR REPLACE VIEW v_users AS SELECT id, n FROM users;", { v_users: READS }],
	["ALTER DOMAIN posint SET NOT NULL;", { dm: WRITES }],
	/* AE2-3 of r22: a sequence another session's nextval takes a lock on, by the name it has at the file's end */
	["ALTER SEQUENCE seq RESTART WITH 100;", { seq: WRITES }],
	["ALTER SEQUENCE seq OWNED BY ids.id;", { seq: WRITES }],
	["ALTER SEQUENCE seq OWNER TO CURRENT_USER;", { seq: READS }],
	["ALTER SEQUENCE seq SET UNLOGGED;", { seq: READS }],
	["ALTER SEQUENCE seq RENAME TO seq2;", { seq2: READS }],
	["ALTER SEQUENCE seq SET SCHEMA s;", { "s.seq": READS }],
	["DROP SEQUENCE seq_free;", { seq_free: READS }],
	/* a CASCADE drops ids's default, which calls seq, and locks ids, which the history's text does not show */
	["DROP SEQUENCE seq CASCADE;", { ids: READS, seq: READS }],
	["CREATE SEQUENCE seq_new;\nALTER SEQUENCE seq_new RESTART;", {}],
	/* a DROP of a table, or of its column, drops the sequence a serial or identity column owns, without CASCADE */
	["DROP TABLE serials;", { serials: READS, serials_id_seq: READS }],
	["ALTER TABLE serials DROP COLUMN id;", { serials: READS, serials_id_seq: READS }],
	["ALTER TABLE serials DROP COLUMN n;", { serials: READS }],
	/* an ALTER TYPE … CASCADE rewrites each table of the type, made OF it, which the history's facts do not show */
	["ALTER TYPE pr RENAME ATTRIBUTE a TO c CASCADE;", { typed: READS }],
	["ALTER TYPE pr ADD ATTRIBUTE x int CASCADE;", { typed: READS }],
	["ALTER TYPE pr DROP ATTRIBUTE b CASCADE;", { typed: READS }],
	/* what blocks nothing */
	["COMMENT ON TABLE orders IS 'x';", {}],
	["GRANT SELECT ON orders TO PUBLIC;", {}],
	["CREATE STATISTICS st ON id, user_id FROM orders;", {}],
	["ALTER INDEX orders_user RENAME TO orders_u;", {}],
	["UPDATE orders SET id = 0;", {}],
]

/**
 * What pg-held.ts's map of a case's file warns of where it is not what Postgres holds: what it names,
 * and what it says it locks that it cannot name, the objects a DROP … CASCADE dropped among them
 */
type Mapped = Unnamed & { held: Readonly<Record<string, string>> }

// lookup-table: the CASES whose map warns of what it cannot name, by statement
export const MAPPED: Readonly<Record<string, Mapped>> = {
	"ALTER TABLE serials DROP COLUMN id;": { held: { serials: READS }, others: ["the sequences serials owns"] },
	"ALTER TYPE pr ADD ATTRIBUTE x int CASCADE;": { held: {}, others: ["the tables of type pr"] },
	"ALTER TYPE pr DROP ATTRIBUTE b CASCADE;": { cascades: ["pr.b"], held: {}, others: ["the tables of type pr"] },
	"ALTER TYPE pr RENAME ATTRIBUTE a TO c CASCADE;": { held: {}, others: ["the tables of type pr"] },
	"DROP DOMAIN posint CASCADE;": { cascades: ["posint"], held: { dm: READS } },
	"DROP SEQUENCE seq CASCADE;": { cascades: ["seq"], held: { seq: READS } },
	"DROP TABLE orders;": { held: { orders: READS }, others: ["the sequences orders owns"] },
	"DROP TABLE serials;": { held: { serials: READS }, others: ["the sequences serials owns"] },
}

/**
 * The history's addition that leaves a table `role` owns, for a DROP or REASSIGN OWNED BY it, which
 * locks each, and the map's warning of one: what Postgres holds, and what it cannot name
 */
export const owning = (role: string): { history: string; mapped: Mapped } => ({
	history: `CREATE TABLE owned (n int);\nALTER TABLE owned OWNER TO ${role};`,
	mapped: { held: {}, owners: [`everything ${role} owns`] },
})

// lookup-table: each statement on the role `owning` names, with what Postgres 17 holds blocked at the file's end
export const OWNING: ReadonlyArray<readonly [(role: string) => string, Readonly<Record<string, string>>]> = [
	[(role) => `DROP OWNED BY ${role};`, { owned: READS }],
	[(role) => `REASSIGN OWNED BY ${role} TO CURRENT_USER;`, { owned: READS }],
]
