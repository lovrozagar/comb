/**
 * The replay's rewrite of a statement into pg_default, a tablespace it left out the CREATE of
 * (PR5 of r22b): each place a statement names a tablespace, nothing a comment, a string, a dollar
 * quote or a quoted name holds, and a rewrite whose parse is not the statement's own run as written.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { loadPostgresParser, parsePostgres } from "./pg-parser.ts"
import { inDefault, leaveOutTablespace, tokensOf } from "./pg-replay-tablespaces.ts"

beforeAll(loadPostgresParser)

const FAST = new Set(["fast", "Mixed"])

/** `sql`, one statement, as the replay would run it with FAST left out */
function moved(sql: string, left: ReadonlySet<string> = FAST) {
	const [raw] = parsePostgres(sql).stmts as Array<{ stmt: unknown }>
	return inDefault(left, sql, raw?.stmt)
}

describe("inDefault", () => {
	it.each([
		["CREATE TABLE t (id int) TABLESPACE fast", "CREATE TABLE t (id int) TABLESPACE pg_default"],
		["CREATE INDEX i ON t (id) TABLESPACE FAST", "CREATE INDEX i ON t (id) TABLESPACE pg_default"],
		[
			"CREATE TABLE t (id int PRIMARY KEY USING INDEX TABLESPACE fast)",
			"CREATE TABLE t (id int PRIMARY KEY USING INDEX TABLESPACE pg_default)",
		],
		["ALTER TABLE t SET TABLESPACE fast", "ALTER TABLE t SET TABLESPACE pg_default"],
		[
			"ALTER TABLE ALL IN TABLESPACE fast SET TABLESPACE pg_default",
			"ALTER TABLE ALL IN TABLESPACE pg_default SET TABLESPACE pg_default",
		],
		["REINDEX (TABLESPACE fast) TABLE t", "REINDEX (TABLESPACE pg_default) TABLE t"],
		[
			"CREATE MATERIALIZED VIEW v TABLESPACE fast AS SELECT 1",
			"CREATE MATERIALIZED VIEW v TABLESPACE pg_default AS SELECT 1",
		],
		['CREATE TABLE t (id int) TABLESPACE "Mixed"', "CREATE TABLE t (id int) TABLESPACE pg_default"],
	])("runs %j as %j", (sql, sql2) => {
		expect(moved(sql)?.sql).toBe(sql2)
	})

	it("names each tablespace it moved from once", () => {
		expect(moved('CREATE TABLE t (id int PRIMARY KEY USING INDEX TABLESPACE "Mixed") TABLESPACE fast')?.names).toEqual([
			"Mixed",
			"fast",
		])
		expect(moved("CREATE TABLE t (id int UNIQUE USING INDEX TABLESPACE fast) TABLESPACE fast")?.names).toEqual(["fast"])
	})

	it("leaves a comment, a string, a dollar quote and an E string as they are", () => {
		const sql = `CREATE TABLE t (id int DEFAULT length('tablespace fast' || E'\\'tablespace fast' || $q$tablespace fast$q$)) /* tablespace /* fast */ tablespace fast */ -- tablespace fast\nTABLESPACE fast`
		expect(moved(sql)?.sql).toBe(sql.replace(/fast$/, "pg_default"))
	})

	it("runs as written a statement that names none of them, or when none was left out", () => {
		expect(moved("CREATE TABLE t (id int) TABLESPACE slow")).toBeUndefined()
		expect(moved("CREATE TABLE t (id int)")).toBeUndefined()
		expect(moved('CREATE TABLE t (id int) TABLESPACE "FAST"')).toBeUndefined()
		expect(moved("CREATE TABLE t (id int) TABLESPACE fast", new Set())).toBeUndefined()
	})

	it("runs as written a statement whose rewrite parses as another, as a column named tablespace", () => {
		expect(moved("CREATE TABLE t (tablespace fast)")).toBeUndefined()
	})
})

describe("tokensOf", () => {
	it("reads a quoted name with its doubled quote, and a lone mark as a token of its own", () => {
		expect(tokensOf('"a""b" ;').map(({ kind, value }) => [kind, value])).toEqual([
			["name", 'a"b'],
			["other", ";"],
		])
	})

	it("ends at the text's end inside an unclosed comment, string or dollar quote", () => {
		expect(tokensOf("a /* b /* c */")).toHaveLength(1)
		expect(tokensOf("a 'b")).toHaveLength(1)
		expect(tokensOf("a $q$ b")).toHaveLength(1)
	})

	it("reads a $ inside a word, or a positional parameter, as no dollar quote", () => {
		expect(tokensOf("a$b$ c").map(({ value }) => value)).toEqual(["a$b$", "c"])
		expect(tokensOf("$1 tablespace").map(({ value }) => value)).toEqual(["$", "1", "tablespace"])
	})
})

describe("leaveOutTablespace", () => {
	it("adds a CREATE, takes a DROP, and moves a rename, but no other rename", () => {
		const left = new Set<string>()
		leaveOutTablespace(left, "CreateTableSpaceStmt", { tablespacename: "a" })
		leaveOutTablespace(left, "CreateTableSpaceStmt", { tablespacename: "b" })
		leaveOutTablespace(left, "DropTableSpaceStmt", { tablespacename: "b" })
		leaveOutTablespace(left, "RenameStmt", { newname: "c", renameType: "OBJECT_TABLESPACE", subname: "a" })
		leaveOutTablespace(left, "RenameStmt", { newname: "d", renameType: "OBJECT_ROLE", subname: "c" })
		leaveOutTablespace(left, "AlterTableSpaceOptionsStmt", { tablespacename: "e" })
		expect([...left]).toEqual(["c"])
	})
})
