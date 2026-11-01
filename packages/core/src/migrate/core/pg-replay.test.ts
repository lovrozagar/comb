import { beforeAll, describe, expect, it } from "vitest"
import { readLiveObjects } from "./pg-live-objects.ts"
import { CATALOG } from "./pg-live-catalog.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { ARM_MAKERS, cutConcurrently, makesCompared, replayCatalog, replayStatements, UNSEEN } from "./pg-replay.ts"
import { parsePostgres } from "./pg-parser.ts"
import { ReplayFailed } from "./replay-failed.ts"

beforeAll(loadPostgresParser)

const tree = (sql: string) => parsePostgres(sql).stmts
const file = (sql: string) => [{ name: "1_a.sql", sql }]
const TARGET = { devUrl: "postgres://dev/dev", lockTimeout: "5s", schema: "public", url: "postgres://app/app" }

describe("cutConcurrently (P5 of r19, ruled: the tree decides, the scanner cuts, the reparse proves)", () => {
	it.each([
		[
			"CREATE INDEX CONCURRENTLY \"concurrently\" ON t (a) WHERE b <> 'concurrently' /* concurrently */",
			"CREATE INDEX \"concurrently\" ON t (a) WHERE b <> 'concurrently' /* concurrently */",
		],
		[
			"-- build concurrently\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a)",
			"-- build concurrently\nCREATE UNIQUE INDEX IF NOT EXISTS i ON t (a)",
		],
		["DROP INDEX CONCURRENTLY IF EXISTS i", "DROP INDEX IF EXISTS i"],
		["REINDEX TABLE CONCURRENTLY t", "REINDEX TABLE t"],
	])("cuts only the keyword of %j", (sql, want) => {
		expect(cutConcurrently(sql, tree(sql))).toBe(want)
	})

	it("refuses a REINDEX whose option list the cut would leave empty, which the parser refuses: loud, never guessed", () => {
		const sql = "REINDEX (CONCURRENTLY) INDEX i"
		expect(() => cutConcurrently(sql, tree(sql))).toThrow(/comb could not replay .* without CONCURRENTLY/)
	})

	it("refuses when the tree names the flag and the code holds no CONCURRENTLY to cut, only quoted and literal ones", () => {
		const sql = "CREATE INDEX \"concurrently\" ON t (a) WHERE b <> 'concurrently'"
		const flagged = tree(sql) as Array<{ stmt: { IndexStmt: Record<string, unknown> } }>
		;(flagged[0] as { stmt: { IndexStmt: Record<string, unknown> } }).stmt.IndexStmt["concurrent"] = true
		expect(() => cutConcurrently(sql, flagged)).toThrow(/without CONCURRENTLY/)
	})
})

describe("replayStatements", () => {
	it("sends each statement as written, an index built CONCURRENTLY without it, and skips VACUUM and a bare CLUSTER", () => {
		const sql =
			"CREATE TABLE t (a int);\nCREATE INDEX CONCURRENTLY i ON t (a);\nVACUUM t;\nANALYZE t;\nCLUSTER;\nCLUSTER t USING i;"
		expect(replayStatements(file(sql)).map(({ sql: sent }) => sent)).toEqual([
			"CREATE TABLE t (a int)",
			"CREATE INDEX i ON t (a)",
			"ANALYZE t",
			"CLUSTER t USING i",
		])
	})

	it("sends a REINDEX without options, and a statement the parser cannot read, as written, for dev to judge", () => {
		expect(replayStatements(file("REINDEX TABLE t;\nREINDEX TABLE CONCURRENTLY t;")).map(({ sql }) => sql)).toEqual([
			"REINDEX TABLE t",
			"REINDEX TABLE t",
		])
		expect(replayStatements(file("SELEC 1;")).map(({ sql }) => sql)).toEqual(["SELEC 1"])
		expect(makesCompared(file("SELEC 1;"))).toBe(false)
	})

	it.each([
		["ALTER SYSTEM SET work_mem = '4MB'", "ALTER SYSTEM runs only outside a transaction"],
		["CREATE DATABASE other", "CREATE DATABASE runs only outside a transaction"],
		["DROP TABLESPACE ts", "DROP TABLESPACE runs only outside a transaction"],
		["COMMIT", "baseline replays the history in one transaction of its own"],
		["BEGIN", "baseline replays the history in one transaction of its own"],
	])("stops on %j, naming it", (sql, said) => {
		expect(() => replayStatements(file(sql))).toThrow(said)
	})
})

/* R1 of stack 2: what the tree cannot see a statement make counts as making something compared, so the replay runs */
describe("makesCompared on what a statement makes out of the tree's sight", () => {
	it.each([
		"DO $$ BEGIN EXECUTE 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS ''select 1'''; END $$;",
		"CALL make_things();",
		"PREPARE p AS SELECT 1;\nEXECUTE p;",
		"CREATE FUNCTION mk() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'CREATE VIEW v AS SELECT 1'; END $$;\nSELECT mk();",
	])("reads %j as making something compared", (sql) => {
		expect(makesCompared(file(sql))).toBe(true)
	})

	it("reads a call of a function no history file defines, and a plain serial or identity table, as making nothing", () => {
		expect(makesCompared(file("SELECT pg_catalog.now();\nSELECT set_config('a.b', 'c', false);"))).toBe(false)
		expect(makesCompared(file("CREATE TABLE t (id serial PRIMARY KEY, n bigint GENERATED ALWAYS AS IDENTITY);"))).toBe(
			false,
		)
	})
})

describe("makesCompared", () => {
	it.each([
		["CREATE VIEW v AS SELECT 1", true],
		["CREATE TABLE t (id int);\nALTER TABLE t FORCE ROW LEVEL SECURITY", true],
		["CREATE SEQUENCE s", true],
		["CREATE TYPE mood AS RANGE (subtype = int4)", true],
		["CREATE TABLE t (id serial PRIMARY KEY);\nCREATE INDEX i ON t (id);\nALTER TABLE t ADD COLUMN b int", false],
		["CREATE TABLE t AS SELECT 1 AS a", false],
	])("reads %j as making something compared: %s", (sql, want) => {
		expect(makesCompared(file(sql))).toBe(want)
	})
})

/** A postgres.js stand-in: each query it was sent, answering `rows` to the catalog read and nothing else */
function fake(rows: Array<Record<string, unknown>> = [], fail?: (query: string) => Error | undefined) {
	const sent: Array<[string, unknown[]]> = []
	const given: Array<Record<string, unknown>> = []
	const connect = (options: Record<string, unknown>) => (
		given.push(options),
		{
			end: async () => undefined,
			unsafe: async (query: string, params: unknown[]) => {
				sent.push([query, params])
				const error = fail?.(query)
				if (error !== undefined) throw error
				return query === CATALOG ? rows : []
			},
		}
	)
	return { given, load: async () => connect, sent }
}

describe("replayCatalog", () => {
	it("replays in one transaction it rolls back, reading with the target's own query (the reviewer's addition B)", async () => {
		const dev = fake([{ name: "dev_user", what: "user" }])
		await replayCatalog(
			{ ...TARGET, schema: "app" },
			{ files: file("CREATE TABLE t (a int);"), targetUser: "app_user" },
			dev.load,
		)
		const target = fake([{ name: "app_user", what: "user" }])
		await readLiveObjects({ schema: "app", url: TARGET.url }, target.load)
		expect(dev.sent.map(([query]) => query)).toEqual([
			"BEGIN",
			'CREATE SCHEMA IF NOT EXISTS "app"',
			'SET LOCAL search_path TO "app"',
			"CREATE TABLE t (a int)",
			CATALOG,
			"ROLLBACK",
		])
		expect(dev.sent.find(([query]) => query === CATALOG)).toEqual(target.sent[0])
		/* one connection, so the transaction holds every statement, and dev's notices kept off the terminal */
		const [options] = dev.given as [{ max: number; onnotice: () => unknown }]
		expect([options.max, options.onnotice()]).toEqual([1, undefined])
	})

	it("names dev's role as the target's in a policy, so CURRENT_USER compares as each database was built (addition A)", async () => {
		const dev = fake([
			{ name: "dev_user", what: "user" },
			{ how: "for all, to dev_user, zeta, permissive", name: "p", on_table: "t", what: "policy" },
			{ how: "for all, to alpha, public, restrictive", name: "q", on_table: "t", what: "policy" },
		])
		const live = await replayCatalog(TARGET, { files: file("SELECT 1;"), targetUser: "app_user" }, dev.load)
		expect(live.user).toBe("app_user")
		expect([...(live.policies.get("t") ?? [])]).toEqual([
			["p", "for all, to app_user, zeta, permissive"],
			["q", "for all, to alpha, public, restrictive"],
		])
		const same = await replayCatalog(
			TARGET,
			{ files: file("SELECT 1;"), targetUser: "dev_user" },
			fake([{ name: "dev_user", what: "user" }]).load,
		)
		expect(same.user).toBe("dev_user")
	})
})

describe("replayCatalog on what dev refuses", () => {
	it("refuses a statement dev refuses, naming the file, the statement and dev's error, and still rolls back", async () => {
		const dev = fake([], (query) =>
			query.startsWith("CREATE VIEW") ? new Error('column "nope" does not exist') : undefined,
		)
		const replay = replayCatalog(
			TARGET,
			{ files: file("CREATE TABLE t (a int);\nCREATE VIEW v AS SELECT nope FROM t;"), targetUser: "u" },
			dev.load,
		)
		await expect(replay).rejects.toThrow(
			'1_a.sql: devUrl refused "CREATE VIEW v AS SELECT nope FROM t" as baseline replayed the history there: column "nope" does not exist; baseline compares nothing',
		)
		await expect(replay).rejects.toBeInstanceOf(ReplayFailed)
		expect(dev.sent.at(-1)?.[0]).toBe("ROLLBACK")
	})

	it("says comb could not replay when dev itself fails, never naming its password", async () => {
		const dev = fake([], (query) =>
			query === "BEGIN" ? new Error("password authentication failed for postgres://u:hunter2@dev/dev") : undefined,
		)
		const secret = { ...TARGET, devUrl: "postgres://u:hunter2@dev/dev" }
		const replay = replayCatalog(secret, { files: file("SELECT 1;"), targetUser: "u" }, dev.load)
		await expect(replay).rejects.toThrow(/^comb could not replay the history on devUrl: /)
		await expect(replay).rejects.not.toThrow(/hunter2/)
	})
})

/*
 * R1 of stack 2: the gate is held to the catalog read. Each arm the read has names the statements that make what it
 * reads, and each of those has a statement here that makes it, so an arm added to CATALOG without its gate fails
 */
describe("makesCompared's makers, held to CATALOG's arms", () => {
	// lookup-table: one statement per maker node, making what its arm reads
	const MADE_BY: Record<string, string> = {
		AlterTableStmt: "ALTER TABLE t ENABLE ROW LEVEL SECURITY",
		CallStmt: "CALL p()",
		DefineStmt: "CREATE COLLATION c (provider = icu, locale = 'und')",
		CompositeTypeStmt: "CREATE TYPE c AS (a int)",
		CreateDomainStmt: "CREATE DOMAIN d AS int",
		CreateExtensionStmt: "CREATE EXTENSION citext",
		CreateFunctionStmt: "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1'",
		CreatePolicyStmt: "CREATE POLICY p ON t USING (true)",
		CreateRangeStmt: "CREATE TYPE r AS RANGE (subtype = int4)",
		CreateSeqStmt: "CREATE SEQUENCE s",
		CreateTableAsStmt: "CREATE MATERIALIZED VIEW m AS SELECT 1",
		CreateTrigStmt: "CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()",
		DoStmt: "DO $$ BEGIN NULL; END $$",
		ExecuteStmt: "EXECUTE p",
		RuleStmt: "CREATE RULE r AS ON INSERT TO t DO NOTHING",
		ViewStmt: "CREATE VIEW v AS SELECT 1",
	}

	it("gates every arm the catalog read has, and nothing it lacks; the connecting role is made by no statement", () => {
		const arms = new Set([...CATALOG.matchAll(/SELECT '([a-z]+)'/g)].map((match) => match[1] as string))
		expect([...arms].sort()).toEqual([...Object.keys(ARM_MAKERS), "user"].sort())
	})

	it.each(Object.entries(ARM_MAKERS).flatMap(([arm, makers]) => Object.keys(makers).map((node) => [arm, node])))(
		"has the %s arm's %s make it",
		(_, node) => {
			const sql = MADE_BY[node] as string
			expect([sql !== undefined && makesCompared(file(`${sql};`))]).toEqual([true])
		},
	)

	it.each([...UNSEEN])("counts %s, whose effect the tree cannot see", (node) => {
		expect(makesCompared(file(`${MADE_BY[node] as string};`))).toBe(true)
	})
})
