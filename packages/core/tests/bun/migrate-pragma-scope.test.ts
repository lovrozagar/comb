/// <reference types="bun-types" />
/**
 * S1 of r21 on a bun:sqlite file, through the real CLI: a connection-scoped pragma one file
 * approves ends with that file, in the proof copy (bun:sqlite under Bun) and in the apply.
 */
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import {
	BREAKS_CHECK,
	IGNORE_CHECKS,
	KEEP,
	migrate,
	SCOPED_PRAGMAS,
	type ScopeProject,
	scopeProject,
	setThenRead,
} from "../../src/migrate/__fixtures__/pragma-scope.ts"

const projects: ScopeProject[] = []
afterEach(() => {
	for (const made of projects.splice(0)) made.remove()
})

async function project(files: Record<string, string>): Promise<ScopeProject> {
	const made = await scopeProject("bun-sqlite", files)
	projects.push(made)
	return made
}

function column(path: string, sql: string): unknown[] {
	const db = new Database(path, { readonly: true })
	try {
		return db
			.query(sql)
			.values()
			.map((row) => row[0])
	} finally {
		db.close()
	}
}

/** What `sql` reads on a connection nothing has set */
function fresh(sql: string): unknown {
	const db = new Database(":memory:")
	try {
		return db.query(sql).values()[0]?.[0]
	} finally {
		db.close()
	}
}

describe("a file's pragmas end with the file on bun:sqlite (S1 of r21; siblings recursive_triggers, legacy_alter_table, case_sensitive_like)", () => {
	it("refuses 0002's CHECK-breaking insert in the same run as the 0001 that approved ignore_check_constraints, as apart", async () => {
		const together = await project(KEEP)
		expect((await migrate(together.dir, "apply")).code).toBe(0)
		await together.write({ "0001_t.sql": IGNORE_CHECKS, "0002_bad.sql": BREAKS_CHECK })
		const check = await migrate(together.dir, "check")
		expect(check.code).toBe(1)
		expect(check.text).toContain("CHECK constraint failed")
		expect((await migrate(together.dir, "apply")).code).toBe(1)

		const apart = await project({ "0001_t.sql": IGNORE_CHECKS })
		expect((await migrate(apart.dir, "apply")).code).toBe(0)
		await apart.write({ "0002_bad.sql": BREAKS_CHECK })
		const later = await migrate(apart.dir, "apply")
		expect(later.code).toBe(1)
		expect(later.text).toContain("CHECK constraint failed")
		expect(column(apart.db, "SELECT v FROM t")).toEqual([-1])
	})

	for (const pragma of SCOPED_PRAGMAS)
		it(`the next file reads ${pragma.name} as a fresh connection has it`, async () => {
			const { db, dir } = await project(setThenRead(pragma))
			const apply = await migrate(dir, "apply")
			expect(apply.code, apply.text).toBe(0)
			expect(column(db, "SELECT v FROM seen")).toEqual([fresh(pragma.read)])
		})
})
