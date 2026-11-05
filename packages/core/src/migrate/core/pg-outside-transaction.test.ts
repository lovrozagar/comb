import { beforeAll, describe, expect, it } from "vitest"
import { beyondDatabase, blockAfter, insideOnly, nodeOf, outsideOnly } from "./pg-outside-transaction.ts"
import { loadPostgresParser, parsePostgres } from "./pg-parser.ts"

beforeAll(loadPostgresParser)

/** What `sql`'s one statement is when Postgres runs it only outside a transaction */
const outside = (sql: string) => outsideOnly(...nodeOf(parsePostgres(sql).stmts))

/** What `sql`'s one statement is when its scope is the server or another database */
const beyond = (sql: string) => beyondDatabase(...nodeOf(parsePostgres(sql).stmts))

/** A CREATE SUBSCRIPTION with `options`, as outsideOnly reads it */
const create = (options: string) => outside(`CREATE SUBSCRIPTION s CONNECTION 'x' PUBLICATION p${options}`)

/* P8 of r19: the one table, as Postgres 17 refused each in a transaction block (.tmp/grunt/p18/runs/8954e05-probe-p8-*.log) */
describe("outsideOnly", () => {
	it.each([
		["CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)", "CREATE INDEX CONCURRENTLY"],
		["DROP INDEX CONCURRENTLY IF EXISTS i", "DROP INDEX CONCURRENTLY"],
		["REINDEX INDEX CONCURRENTLY i", "REINDEX CONCURRENTLY"],
		["ALTER TABLE ev DETACH PARTITION ev_old CONCURRENTLY", "ALTER TABLE ... DETACH CONCURRENTLY"],
		["VACUUM", "VACUUM"],
		["REINDEX SCHEMA s", "REINDEX SCHEMA"],
		/* P4 of r20: any failover value, beside other options or alone (.tmp/grunt/p18/runs/f761199-probe-p8-20261102T153735Z.log) */
		["ALTER SUBSCRIPTION s SET (failover = true)", "ALTER SUBSCRIPTION ... SET (failover)"],
		["ALTER SUBSCRIPTION s SET (failover = false, synchronous_commit = off)", "ALTER SUBSCRIPTION ... SET (failover)"],
	])("names %j as Postgres's refusal does", (sql, named) => {
		expect(outside(sql)).toBe(named)
	})

	it("reads a subscription's options as Postgres reads a boolean: false, off or 0, and none given as true", () => {
		expect(
			["", " WITH (create_slot)", " WITH (create_slot = true)", " WITH (create_slot = 1)", " WITH (connect = on)"].map(
				create,
			),
		).toEqual(Array(5).fill("CREATE SUBSCRIPTION ... WITH (create_slot = true)"))
		expect(
			[
				" WITH (create_slot = false)",
				" WITH (create_slot = OFF)",
				" WITH (create_slot = 0)",
				" WITH (connect = false)",
			].map(create),
		).toEqual(Array(4).fill(undefined))
	})

	/* a float or an operator is no Integer node: it reads as its text, which is no boolean Postgres takes */
	it.each(["0.0", "+"])("reads an option whose value is %s as written, not off", (value) => {
		const refresh = `ALTER SUBSCRIPTION s SET PUBLICATION p WITH (refresh = ${value})`
		expect(outside(refresh)).toBe(outside("ALTER SUBSCRIPTION s SET PUBLICATION p WITH (refresh = true)"))
	})

	it("leaves out what a transaction holds", () => {
		expect(
			[
				"ANALYZE t",
				"CLUSTER t USING i",
				"REINDEX TABLE t",
				"ALTER TABLE ev DETACH PARTITION ev_old FINALIZE",
				"DISCARD TEMP",
				"COMMIT",
				"ALTER DATABASE d SET work_mem = '4MB'",
				"ALTER DATABASE d WITH CONNECTION LIMIT 5",
				"ALTER SUBSCRIPTION s DROP PUBLICATION p WITH (refresh = false)",
				"ALTER SUBSCRIPTION s DISABLE",
				"ALTER SUBSCRIPTION s SET (synchronous_commit = off)",
				"ALTER SUBSCRIPTION s SET (disable_on_error = true)",
			].map(outside),
		).toEqual(Array(12).fill(undefined))
	})
})

/* P1 of r20: what the dev replay leaves out, as it would outlive the replay's database on devUrl's server */
/** What `sql`'s one statement is outside a transaction when the table or index it names is `partitioned` */
const outsideOf = (sql: string, partitioned: (relation: unknown, index: boolean) => boolean) =>
	outsideOnly(...nodeOf(parsePostgres(sql).stmts), partitioned)

/** A partition lookup a statement that names no table or index never makes */
const never = (): boolean => {
	throw new Error("asked")
}

/* P9 of r21: Postgres 17 refuses these in a transaction block on a partitioned table or index alone (.tmp/grunt/p20/logs/8.6-probe.log) */
describe("outsideOnly of a partitioned table or index", () => {
	it.each([
		["CLUSTER p USING p_at", "CLUSTER", false],
		["REINDEX TABLE p", "REINDEX TABLE", false],
		["REINDEX (VERBOSE) TABLE s.p", "REINDEX TABLE", false],
		["REINDEX INDEX p_at", "REINDEX INDEX", true],
	])("names %j as Postgres's refusal does, asking of its table or index", (sql, named, index) => {
		const asked: Array<[unknown, boolean]> = []
		expect(outsideOf(sql, (relation, isIndex) => (asked.push([relation, isIndex]), true))).toBe(named)
		expect(asked.map(([, isIndex]) => isIndex)).toEqual([index])
	})

	it("leaves a plain table's or index's in a transaction, and asks of nothing else", () => {
		expect(
			["CLUSTER plain USING plain_id", "REINDEX TABLE plain", "REINDEX INDEX plain_id"].map((sql) =>
				outsideOf(sql, () => false),
			),
		).toEqual([undefined, undefined, undefined])
		expect(["CLUSTER", "REINDEX SCHEMA s", "CREATE TABLE t (a int)"].map((sql) => outsideOf(sql, never))).toEqual([
			"CLUSTER",
			"REINDEX SCHEMA",
			undefined,
		])
	})
})

describe("beyondDatabase", () => {
	it.each([
		["ALTER DATABASE app SET work_mem = '4MB'", "ALTER DATABASE"],
		["ALTER DATABASE app REFRESH COLLATION VERSION", "ALTER DATABASE"],
		["ALTER DATABASE app CONNECTION LIMIT 5", "ALTER DATABASE"],
		["ALTER DATABASE app OWNER TO r", "ALTER OWNER of a database"],
		["ALTER ROLE r PASSWORD 'x'", "ALTER ROLE"],
		["ALTER ROLE r SET work_mem = '4MB'", "ALTER ROLE"],
		["ALTER SUBSCRIPTION s DISABLE", "ALTER SUBSCRIPTION"],
		["ALTER SYSTEM SET work_mem = '4MB'", "ALTER SYSTEM"],
		["ALTER TABLESPACE ts SET (seq_page_cost = 1)", "ALTER TABLESPACE"],
		["CHECKPOINT", "CHECKPOINT"],
		["COMMENT ON ROLE r IS 'x'", "COMMENT on a role"],
		["COMMENT ON DATABASE app IS 'x'", "COMMENT on a database"],
		["COPY t TO '/tmp/t.csv'", "COPY with a server file or program"],
		["COPY t FROM PROGRAM 'cat t.csv'", "COPY with a server file or program"],
		["CREATE SUBSCRIPTION s CONNECTION 'x' PUBLICATION p WITH (connect = false)", "CREATE SUBSCRIPTION"],
		["CREATE TABLESPACE ts LOCATION '/x'", "CREATE TABLESPACE"],
		["CREATE DATABASE other", "CREATE DATABASE"],
		["DROP OWNED BY r", "DROP OWNED"],
		["DROP ROLE r", "DROP ROLE"],
		["DROP SUBSCRIPTION s", "DROP SUBSCRIPTION"],
		["DROP TABLESPACE ts", "DROP TABLESPACE"],
		["DROP DATABASE other", "DROP DATABASE"],
		["GRANT r TO s", "GRANT or REVOKE of a role"],
		["GRANT CONNECT ON DATABASE app TO r", "GRANT or REVOKE on a database"],
		["GRANT SET ON PARAMETER work_mem TO r", "GRANT or REVOKE on a server parameter"],
		["REVOKE CREATE ON TABLESPACE ts FROM r", "GRANT or REVOKE on a tablespace"],
		["REASSIGN OWNED BY r TO s", "REASSIGN OWNED"],
		["REINDEX DATABASE app", "REINDEX DATABASE"],
		["REINDEX SYSTEM app", "REINDEX SYSTEM"],
		["ALTER ROLE r RENAME TO s", "RENAME of a role"],
		["SECURITY LABEL ON ROLE r IS 'x'", "SECURITY LABEL on a role"],
		["PREPARE TRANSACTION 'x'", "PREPARE TRANSACTION"],
		["COMMIT PREPARED 'x'", "COMMIT PREPARED"],
		["ROLLBACK PREPARED 'x'", "ROLLBACK PREPARED"],
	])("names %j", (sql, named) => {
		expect(beyond(sql)).toBe(named)
	})

	it("leaves what the replay's database holds to it: its own objects, a COPY of the client's, a narrower REINDEX, a transaction", () => {
		expect(
			[
				"CREATE TABLE t (a int)",
				"ALTER TABLE t OWNER TO r",
				"COMMENT ON TABLE t IS 'x'",
				"GRANT SELECT ON t TO r",
				"ALTER TABLE t RENAME TO u",
				"SECURITY LABEL ON TABLE t IS 'x'",
				"COPY t FROM '/tmp/t.csv'",
				"COPY t FROM STDIN",
				"COPY t TO STDOUT",
				"REINDEX TABLE t",
				"BEGIN",
				"COMMIT",
			].map(beyond),
		).toEqual(Array(12).fill(undefined))
	})
})

/* PA13 of r22b: what a txmode none file sends bare, so Postgres refuses it outside a block as apply's does */
describe("insideOnly and blockAfter", () => {
	it.each([
		["LOCK TABLE t IN SHARE MODE", "LOCK TABLE"],
		["SAVEPOINT s", "SAVEPOINT"],
		["RELEASE s", "RELEASE SAVEPOINT"],
		["ROLLBACK TO s", "ROLLBACK TO SAVEPOINT"],
		["DECLARE c CURSOR FOR SELECT 1", "DECLARE CURSOR"],
		["DECLARE c CURSOR WITH HOLD FOR SELECT 1", undefined],
		["BEGIN", undefined],
		["SELECT 1", undefined],
	])("names %s as %s", (sql, named) => {
		expect(insideOnly(...nodeOf(parsePostgres(sql).stmts))).toBe(named)
	})

	/*
	 * the gate's pin (comb-9d): libpg-query sets a DECLARE's options on every form a history can hold,
	 * which insideOnly reads with no fallback; a parser that drops them fails here, before a NaN
	 * reads every cursor as one without WITH HOLD
	 */
	it.each([
		"DECLARE c CURSOR FOR SELECT 1",
		"DECLARE c BINARY CURSOR FOR SELECT 1",
		"DECLARE c INSENSITIVE CURSOR FOR SELECT 1",
		"DECLARE c ASENSITIVE CURSOR FOR SELECT 1",
		"DECLARE c SCROLL CURSOR FOR SELECT 1",
		"DECLARE c NO SCROLL CURSOR FOR SELECT 1",
		"DECLARE c CURSOR WITH HOLD FOR SELECT 1",
		"DECLARE c CURSOR WITHOUT HOLD FOR SELECT 1",
		"DECLARE c BINARY INSENSITIVE SCROLL CURSOR WITH HOLD FOR SELECT 1",
	])("reads the integer options the parser sets on %s", (sql) => {
		const [type, node] = nodeOf(parsePostgres(sql).stmts)
		expect([type, Number.isInteger(node["options"])]).toEqual(["DeclareCursorStmt", true])
	})

	it.each([
		[false, "BEGIN", true],
		[false, "START TRANSACTION", true],
		[true, "COMMIT", false],
		[true, "ROLLBACK", false],
		[true, "COMMIT AND CHAIN", true],
		[true, "PREPARE TRANSACTION 'p'", false],
		[true, "SAVEPOINT s", true],
		[true, "SELECT 1", true],
		[false, "SELECT 1", false],
	])("from open %s, after %s, is open %s", (open, sql, after) => {
		expect(blockAfter(open, ...nodeOf(parsePostgres(sql).stmts))).toBe(after)
	})
})
