/**
 * SL1 of r22, a regression from plan 20's per-file connection (c3bb8ee): each file of a local libsql
 * file applies on a connection of its own, and that connection must let go of the database when its
 * file ends. Run as a user runs it, the CLI as a process under a descriptor limit below the files'
 * count; and an EXCLUSIVE lock, which would outlive its file, is refused before anything applies.
 */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { migrateCli, migrateProject, sqliteRows } from "../support/migrate-project.ts"

const BIN = path.resolve(import.meta.dirname, "../../../src/bin.ts")

/** `migrate apply core --yes` as a process in `dir`, under `ulimit -n limit` */
function applyLimited(dir: string, limit: number): Promise<{ code: number | null; stderr: string }> {
	return new Promise((done) => {
		const child = spawn("bash", ["-c", `ulimit -n ${limit} && exec bun "$0" migrate apply core --yes -e local`, BIN], {
			cwd: dir,
			stdio: ["ignore", "ignore", "pipe"],
		})
		let stderr = ""
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		child.on("close", (code) => done({ code, stderr }))
	})
}

describe("a local libsql file's connection is closed when its file ends (SL1 of r22; sibling: S1's one sqld client)", () => {
	it("applies 300 files to a libsql file under ulimit -n 256", async () => {
		const files = Object.fromEntries(
			Array.from({ length: 300 }, (_, at) => [
				`${String(at + 1).padStart(4, "0")}_c.sql`,
				`CREATE TABLE c${at + 1} (x INTEGER);\n`,
			]),
		)
		const project = migrateProject(files)
		try {
			const run = await applyLimited(project.dir, 256)
			expect(run.code, run.stderr.slice(-2000)).toBe(0)
			expect(await sqliteRows(project.url, "SELECT count(*) FROM __drizzle_migrations")).toEqual([[300]])
		} finally {
			project.dispose()
		}
	}, 180_000)

	it("refuses an approved EXCLUSIVE file before a plain one at check and at apply, and applies neither", async () => {
		const project = migrateProject({
			"0001_t.sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER);\nINSERT INTO t (v) VALUES (1);\n",
		})
		try {
			expect((await migrateCli(project.dir, ["migrate", "apply", "core", "--yes"])).code).toBe(0)
			fs.writeFileSync(
				path.join(project.migrationsDir, "0002_x.sql"),
				"-- comb:allow-unsafe: bulk load\nPRAGMA locking_mode = EXCLUSIVE;\nCREATE TABLE big (x INTEGER);\n",
			)
			fs.writeFileSync(path.join(project.migrationsDir, "0003_y.sql"), "CREATE TABLE more (x INTEGER);\n")
			spawnSync("atlas", ["migrate", "hash", "--dir", `file://${project.migrationsDir}`])
			for (const mode of ["check", "apply"]) {
				const run = await migrateCli(project.dir, ["migrate", mode, "core", "--yes"])
				expect(run.code, mode).toBe(1)
				expect(run.errors.join("\n"), mode).toMatch(
					/PRAGMA locking_mode = EXCLUSIVE: locking_mode EXCLUSIVE keeps the connection's lock/,
				)
			}
			expect(await sqliteRows(project.url, "SELECT name FROM __drizzle_migrations")).toEqual([["0001_t.sql"]])
		} finally {
			project.dispose()
		}
	}, 60_000)
})
