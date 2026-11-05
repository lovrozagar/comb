/**
 * SL4 of r22 (sibling: tests/bun/busy.test.ts, the bun-sqlite provider): a local SQLite file is shared
 * with the app that serves it, or a second runner. Another process holding the write lock makes comb's
 * apply wait for it, as SQLite's busy timeout does, and a second run that applied the file meanwhile
 * makes this one skip it, never apply it twice nor fail on its record.
 */
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../../src/cli/index.ts"
import { ADD, APP_WRITE, holdExclusive, holdLock, otherRun, TABLE } from "../../support/busy.ts"
import { migrate, type ScopeProject, scopeProject } from "../../../src/migrate/__fixtures__/pragma-scope.ts"
import { sqliteRows } from "../support/migrate-project.ts"

const projects: ScopeProject[] = []
afterEach(() => {
	for (const made of projects.splice(0)) made.remove()
})

/** A libsql project with 0001 applied, and 0002 written, pending */
async function applied(): Promise<ScopeProject> {
	const made = await scopeProject("libsql", TABLE)
	projects.push(made)
	expect((await migrate(made.dir, "apply")).code).toBe(0)
	await made.write(ADD)
	return made
}

const history = (db: string) => sqliteRows(`file:${db}`, "SELECT name FROM __drizzle_migrations ORDER BY id")

describe("migrate apply on a libsql file another process holds the write lock of", () => {
	it("waits for the lock, then applies", async () => {
		const made = await applied()
		const holder = await holdLock(made.db, APP_WRITE, 300)
		const run = await migrate(made.dir, "apply")
		expect(await holder.done).toBe(0)
		expect(run.code, run.text).toBe(0)
		expect(await history(made.db)).toEqual([["0001_t.sql"], ["0002_add.sql"]])
	})

	it("skips a file another run applied while it waited, and applies it once", async () => {
		const made = await applied()
		const holder = await holdLock(made.db, otherRun(), 1500)
		const run = await migrate(made.dir, "apply")
		expect(await holder.done).toBe(0)
		expect(run.code, run.text).toBe(0)
		expect(run.text).toContain("Skip (applied by another run): 0002_add.sql")
		expect(await history(made.db)).toEqual([["0001_t.sql"], ["0002_add.sql"]])
	})
})

/*
 * The holder stands in for an app writer, which commits while comb's apply waits: SQLite's BEGIN IMMEDIATE
 * takes the file's shared lock between its busy-handler sleeps, so the holder's COMMIT can meet a reader
 * and must wait for it under a busy timeout, as an app writer should, where it would fail at once.
 */
describe("the lock holder", () => {
	it("commits once a reader holding the shared lock at its COMMIT lets go", async () => {
		const made = await applied()
		const holder = await holdLock(made.db, APP_WRITE, 200)
		const reader = new DatabaseSync(made.db)
		reader.exec("BEGIN")
		reader.prepare("SELECT count(*) FROM t").get()
		await new Promise((resolve) => setTimeout(resolve, 800))
		reader.exec("COMMIT")
		reader.close()
		expect(await holder.done).toBe(0)
		expect(await sqliteRows(`file:${made.db}`, "SELECT v FROM t")).toEqual([[99]])
	})
})

/* AD7-8 of the area D round-seven review: status opens the file through the provider, not apply's own open */
describe("migrate status on a libsql file another process holds the exclusive lock of", () => {
	it("waits for the lock, then lists what is applied and pending", async () => {
		const made = await applied()
		const holder = await holdExclusive(made.db, 1000)
		const lines: string[] = []
		const out = (line: string) => lines.push(line)
		const code = await runCli(["migrate", "status", "core"], { cwd: made.dir, err: out, out })
		expect(await holder.done).toBe(0)
		expect([code, lines.join("\n")]).toEqual([0, expect.stringMatching(/0001_t\.sql[\s\S]*0002_add\.sql/)])
	})
})
