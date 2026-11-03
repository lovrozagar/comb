/// <reference types="bun-types" />
/**
 * SL4 of r22 on a bun:sqlite file (sibling: tests/integration/libsql/busy.test.ts, the libsql provider):
 * another process holding the write lock makes comb's apply wait for it, and a second run that applied
 * the file meanwhile makes this one skip it, never apply it twice nor fail on its record.
 */
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { ADD, APP_WRITE, holdLock, otherRun, TABLE } from "../support/busy.ts"
import { migrate, type ScopeProject, scopeProject } from "../../src/migrate/__fixtures__/pragma-scope.ts"

const projects: ScopeProject[] = []
afterEach(() => {
	for (const made of projects.splice(0)) made.remove()
})

/** A bun-sqlite project with 0001 applied, and 0002 written, pending */
async function applied(): Promise<ScopeProject> {
	const made = scopeProject("bun-sqlite", TABLE)
	projects.push(made)
	expect((await migrate(made.dir, "apply")).code).toBe(0)
	made.write(ADD)
	return made
}

function history(db: string): unknown[] {
	const read = new Database(db, { readonly: true })
	try {
		return read.query("SELECT name FROM __drizzle_migrations ORDER BY id").values()
	} finally {
		read.close()
	}
}

describe("migrate apply on a bun:sqlite file another process holds the write lock of", () => {
	it("waits for the lock, then applies", async () => {
		const made = await applied()
		const holder = await holdLock(made.db, APP_WRITE, 300)
		const run = await migrate(made.dir, "apply")
		expect(await holder.done).toBe(0)
		expect(run.code).toBe(0)
		expect(history(made.db)).toEqual([["0001_t.sql"], ["0002_add.sql"]])
	})

	it("skips a file another run applied while it waited, and applies it once", async () => {
		const made = await applied()
		const holder = await holdLock(made.db, otherRun(), 1500)
		const run = await migrate(made.dir, "apply")
		expect(await holder.done).toBe(0)
		expect(run.code).toBe(0)
		expect(run.text).toContain("Skip (applied by another run): 0002_add.sql")
		expect(history(made.db)).toEqual([["0001_t.sql"], ["0002_add.sql"]])
	})
})
