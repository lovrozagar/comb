/**
 * The statements on roles a dev replay made that it runs rather than leaves out (PR5 of r22b): which
 * it runs, and the ALTER ROLE it runs without a login, a password and the attributes BARE denies.
 * Postgres runs each in replay-left-out.test.ts; this holds the parse trees no history there writes.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { loadPostgresParser } from "./pg-parser.ts"
import { alterBare, runRole, runsOnMade } from "./pg-replay-made.ts"
import type { Run } from "./pg-replay-roles.ts"
import { nodeOf } from "./pg-outside-transaction.ts"
import { pgRead } from "./pg-split.ts"

beforeAll(loadPostgresParser)

/** `sql`'s one statement, as nodeOf reads it */
function statement(sql: string): { node: Record<string, unknown>; sent: string; type: string } {
	const [read] = pgRead(sql).statements
	const [type, node] = nodeOf(read?.tree as never)
	return { node, sent: String(read?.sent), type }
}

/** A run that made `created`, on a server where another database holds `elsewhere` */
function made(created: string[], elsewhere: string[] = []): Run {
	const sql = { unsafe: async () => elsewhere.map((rolname) => ({ rolname })) }
	return { created, database: "comb_replay_db", sql } as unknown as Run
}

/** `sql`'s ALTER ROLE as the replay runs it */
function bare(sql: string) {
	const { node, sent } = statement(sql)
	return alterBare(node, sent)
}

/** Whether `run` runs `sql`'s one statement */
async function runsOn(sql: string, run: Run): Promise<boolean> {
	const { node, type } = statement(sql)
	return runsOnMade(run, type, node)
}

describe("alterBare", () => {
	it("runs as written an ALTER ROLE that says nothing the replay runs without", () => {
		expect(bare("ALTER ROLE app WITH CREATEDB CONNECTION LIMIT 3")).toEqual({
			bare: false,
			sql: "ALTER ROLE app WITH CREATEDB CONNECTION LIMIT 3",
		})
	})

	it("keeps each option it may, and is bare only for what it gave up", () => {
		expect(
			bare("ALTER ROLE app WITH LOGIN NOCREATEDB NOCREATEROLE INHERIT CONNECTION LIMIT 0 VALID UNTIL 'infinity'"),
		).toEqual({
			bare: true,
			sql: `ALTER ROLE "app" WITH NOCREATEDB NOCREATEROLE INHERIT CONNECTION LIMIT 0 VALID UNTIL 'infinity'`,
		})
		expect(bare("ALTER ROLE \"App\" WITH PASSWORD 'x' CREATEROLE")).toEqual({
			bare: true,
			sql: 'ALTER ROLE "App" WITH CREATEROLE',
		})
	})

	it("runs no statement, and is not bare, for one that only takes away what the replay never gave", () => {
		expect(bare("ALTER ROLE app WITH NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD NULL")).toEqual({
			bare: false,
			sql: undefined,
		})
	})

	it("refuses an option comb does not know, so a new one is never dropped unsaid", () => {
		const node = {
			options: [{ DefElem: { defname: "password" } }, { DefElem: { defname: "newthing" } }],
			role: { rolename: "app" },
		}
		expect(() => alterBare(node, "")).toThrow("comb does not know ALTER ROLE's option newthing")
	})
})

describe("runsOnMade", () => {
	it("runs a statement on roles the replay made alone", async () => {
		const { node, type } = statement("ALTER ROLE app SET work_mem = '8MB'")
		expect(await runsOnMade(made(["app"]), type, node)).toBe(true)
	})

	it("leaves out one on a role it did not make, on CURRENT_USER or ALL, or on a role another database holds", async () => {
		expect(await runsOn("DROP ROLE app, other", made(["app"]))).toBe(false)
		expect(await runsOn("ALTER ROLE CURRENT_USER SET work_mem = '8MB'", made(["app"]))).toBe(false)
		expect(await runsOn("ALTER ROLE ALL SET work_mem = '8MB'", made(["app"]))).toBe(false)
		expect(await runsOn("ALTER TABLE t RENAME TO u", made(["t"]))).toBe(false)
		expect(await runsOn("DROP OWNED BY app", made(["app"], ["app"]))).toBe(false)
	})

	it("runs a GRANT of a role it made, whoever else holds it, as that membership dies with the role (P6 of r21)", async () => {
		const { node, type } = statement("GRANT app TO other")
		expect(await runsOnMade(made(["app"], ["app"]), type, node)).toBe(true)
	})
})

describe("runRole", () => {
	it("leaves any statement but one on roles to the replay, which sends it as it is", () => {
		expect(runRole(made(["t"]), statement("ALTER TABLE t RENAME TO u"))).toBeUndefined()
		expect(runRole(made([]), statement("CREATE TABLE t (id int)"))).toBeUndefined()
	})
})
