/**
 * S1 of r21 on a libsql file, through the real CLI: a connection-scoped pragma one file approves
 * ends with that file, in the proof copy and in the apply, so a later file is checked and applied
 * as it would be alone, and as wrangler runs it on D1.
 */
import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it } from "vitest"
import {
	BREAKS_CHECK,
	IGNORE_CHECKS,
	KEEP,
	migrate,
	SCOPED_PRAGMAS,
	type ScopeProject,
	scopeProject,
	setThenRead,
} from "../../../src/migrate/__fixtures__/pragma-scope.ts"

const projects: ScopeProject[] = []
afterEach(() => {
	for (const made of projects.splice(0)) made.remove()
})

function project(files: Record<string, string>): ScopeProject {
	const made = scopeProject("libsql", files)
	projects.push(made)
	return made
}

async function column(db: string, sql: string): Promise<unknown[]> {
	const client = createClient({ url: `file:${db}` })
	try {
		return (await client.execute(sql)).rows.map((row) => row[0])
	} finally {
		client.close()
	}
}

/** What `sql` reads on a connection nothing has set */
async function fresh(sql: string): Promise<unknown> {
	const client = createClient({ url: ":memory:" })
	try {
		return (await client.execute(sql)).rows[0]?.[0]
	} finally {
		client.close()
	}
}

describe("a file's pragmas end with the file on libsql (S1 of r21; siblings recursive_triggers, legacy_alter_table, case_sensitive_like)", () => {
	it("refuses 0002's CHECK-breaking insert in the same run as the 0001 that approved ignore_check_constraints, as apart", async () => {
		const together = project(KEEP)
		expect((await migrate(together.dir, "apply")).code).toBe(0)
		together.write({ "0001_t.sql": IGNORE_CHECKS, "0002_bad.sql": BREAKS_CHECK })
		const check = await migrate(together.dir, "check")
		expect(check.code, check.text).toBe(1)
		expect(check.text).toContain("CHECK constraint failed")
		const apply = await migrate(together.dir, "apply")
		expect(apply.code, apply.text).toBe(1)
		expect(await column(together.db, "SELECT count(*) FROM sqlite_master WHERE name = 't'")).toEqual([0])

		const apart = project({ "0001_t.sql": IGNORE_CHECKS })
		expect((await migrate(apart.dir, "apply")).code).toBe(0)
		apart.write({ "0002_bad.sql": BREAKS_CHECK })
		const later = await migrate(apart.dir, "apply")
		expect(later.code, later.text).toBe(1)
		expect(later.text).toContain("CHECK constraint failed")
		expect(await column(apart.db, "SELECT v FROM t")).toEqual([-1])
	})

	it.each(SCOPED_PRAGMAS)("the next file reads $name as a fresh connection has it", async (pragma) => {
		const { db, dir } = project(setThenRead(pragma))
		const apply = await migrate(dir, "apply")
		expect(apply.code, apply.text).toBe(0)
		expect(await column(db, "SELECT v FROM seen")).toEqual([await fresh(pragma.read)])
	})
})
