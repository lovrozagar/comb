import { beforeAll, describe, expect, it } from "vitest"
import { beyondDatabase, nodeOf } from "./pg-outside-transaction.ts"
import { loadPostgresParser, parsePostgres } from "./pg-parser.ts"

beforeAll(loadPostgresParser)

/** What beyondDatabase reads `sql` as */
const beyond = (sql: string) => beyondDatabase(...nodeOf(parsePostgres(sql).stmts))

/* PR2 of r22b: a function that acts on the server, called where a statement runs it, is the statement's scope */
describe("beyondDatabase of a call that acts on the server (PR2; sibling: BEYOND's statements)", () => {
	it.each([
		["SELECT pg_create_physical_replication_slot('s', true)", "pg_create_physical_replication_slot"],
		["SELECT pg_create_logical_replication_slot('s', 'pgoutput')", "pg_create_logical_replication_slot"],
		["SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_stat_activity", "pg_terminate_backend"],
		["SELECT public.dblink_exec('dbname=x', 'CREATE ROLE r')", "dblink_exec"],
		["INSERT INTO t SELECT pg_reload_conf()", "pg_reload_conf"],
		["CALL p(lo_export(1, '/tmp/x'))", "lo_export"],
		["EXPLAIN ANALYZE SELECT pg_switch_wal()", "pg_switch_wal"],
		["CREATE TABLE x AS SELECT pg_drop_replication_slot('s')", "pg_drop_replication_slot"],
		["ALTER TABLE t ADD COLUMN b bool DEFAULT pg_reload_conf()", "pg_reload_conf"],
		["COPY (SELECT pg_rotate_logfile()) TO STDOUT", "pg_rotate_logfile"],
		["SELECT * FROM dblink('dbname=x', 'SELECT 1') AS r(n int)", "dblink"],
		["SELECT dblink_open('c', 'cur', 'SELECT 1')", "dblink_open"],
		["SELECT * FROM dblink_get_result('c') AS r(n int)", "dblink_get_result"],
	])("names %j as a call of %s", (sql, call) => {
		expect(beyond(sql)).toBe(`a call of ${call}`)
	})

	it.each([
		"CREATE VIEW v AS SELECT pg_reload_conf()",
		"CREATE FUNCTION f() RETURNS bool LANGUAGE sql BEGIN ATOMIC SELECT pg_terminate_backend(1); END",
		"EXPLAIN SELECT pg_switch_wal()",
		"EXPLAIN (ANALYZE false) SELECT pg_switch_wal()",
		"ALTER POLICY p ON t USING (pg_reload_conf())",
		"CREATE DOMAIN d AS bool CHECK (pg_reload_conf())",
		"CREATE POLICY p ON t USING (pg_reload_conf())",
		"CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW WHEN (pg_reload_conf()) EXECUTE FUNCTION f()",
		"PREPARE q AS SELECT pg_reload_conf()",
		"CREATE RULE r AS ON INSERT TO t DO ALSO SELECT pg_reload_conf()",
		"CREATE TABLE t (b bool DEFAULT pg_reload_conf())",
		"CREATE TABLE x AS SELECT pg_switch_wal() WITH NO DATA",
		"SELECT pg_read_file('postgresql.conf')",
		"SELECT dblinker()",
		'SELECT "PG_RELOAD_CONF"()',
	])("leaves %j to its database: a definition, a plan, or a call that only reads", (sql) => {
		expect(beyond(sql)).toBeUndefined()
	})
})
