/**
 * SL5 of r22 (sibling: migrate-cli's pre-0.5.0 hash): SQLite skips only space, tab, newline, form feed and
 * return, so `a b` is column a of type b while `a`, a no-break space and `b` is one column named that. A file
 * edited from one to the other is edited; a row 0.20 recorded with every space folded still matches its file.
 */
import { createClient } from "@libsql/client"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { foldedMigrationHash, SPACES_KEPT_SINCE } from "../../../src/migrate/core/parse.ts"
import { migrateCli, migrateProject } from "../support/migrate-project.ts"

const ASCII = "CREATE TABLE t (id INTEGER PRIMARY KEY, a b);\n"
const UNICODE = "CREATE TABLE t (id INTEGER PRIMARY KEY, a b);\n"

describe("migrate status and check on a file holding a space SQLite reads as part of a name", () => {
	it("refuses an applied file edited to name another column through such a space", async () => {
		const project = migrateProject({ "1_t.sql": ASCII })
		try {
			expect((await migrateCli(project.dir, ["migrate", "apply", "core"])).code).toBe(0)
			fs.writeFileSync(path.join(project.migrationsDir, "1_t.sql"), UNICODE)
			spawnSync("atlas", ["migrate", "hash", "--dir", `file://${project.migrationsDir}`])
			for (const command of ["status", "check"]) {
				const run = await migrateCli(project.dir, ["migrate", command, "core"])
				expect(run.code).toBe(1)
				expect(run.errors.join("\n")).toContain("1_t.sql was applied, then edited")
			}
		} finally {
			project.dispose()
		}
	})

	it("skips such a file recorded by 0.20, which folded the space, before comb kept it", async () => {
		const project = migrateProject({ "1_t.sql": UNICODE })
		try {
			expect((await migrateCli(project.dir, ["migrate", "apply", "core"])).code).toBe(0)
			const client = createClient({ url: project.url })
			await client.execute({
				args: [foldedMigrationHash(UNICODE), SPACES_KEPT_SINCE - 60_000],
				sql: "UPDATE __drizzle_migrations SET hash = ?, created_at = ?",
			})
			client.close()
			const run = await migrateCli(project.dir, ["migrate", "check", "core"])
			expect(run.code, run.errors.join("\n")).toBe(0)
		} finally {
			project.dispose()
		}
	})
})
