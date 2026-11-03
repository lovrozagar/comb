/**
 * SL3 of r22: a libsql target is proven on libsql's engine (sibling: SD1's D1 engine proof). Check
 * runs a pending file on the SQLite its files apply on: what libsql refuses is refused at check, not
 * at apply, and libsql's own syntax, a vector index among it, is proven as any other file is; and a
 * database built from such a history baselines.
 */
import { createClient } from "@libsql/client"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { migrateCli, migrateProject, type MigrateProject } from "../support/migrate-project.ts"

const BASE = {
	"0001_t.sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER, emb F32_BLOB(3));\nINSERT INTO t (v) VALUES (1);\n",
}

/** A project with `files` applied, then `pending` written beside them and hashed */
async function appliedThen(files: Record<string, string>, pending: Record<string, string>): Promise<MigrateProject> {
	const project = migrateProject(files)
	const applied = await migrateCli(project.dir, ["migrate", "apply", "core", "--yes"])
	expect(applied.code, applied.errors.join("\n")).toBe(0)
	for (const [name, sql] of Object.entries(pending)) fs.writeFileSync(path.join(project.migrationsDir, name), sql)
	spawnSync("atlas", ["migrate", "hash", "--dir", `file://${project.migrationsDir}`])
	return project
}

describe("a libsql target is proven on libsql's engine (SL3; sibling: SD1's D1 engine proof)", () => {
	it.each([
		["a digit separator", "CREATE TABLE plans (id INTEGER PRIMARY KEY, quota INTEGER NOT NULL DEFAULT 1_000_000);\n"],
		[
			"if()",
			"CREATE TABLE flags (id INTEGER PRIMARY KEY, on_ INTEGER);\nINSERT INTO flags (on_) SELECT if(v > 0, 1, 0) FROM t;\n",
		],
	])("refuses at check a file holding %s, which libsql's SQLite cannot run", async (_, sql) => {
		const project = await appliedThen(BASE, { "0002_new.sql": sql })
		try {
			const check = await migrateCli(project.dir, ["migrate", "check", "core"])
			expect(check.code).toBe(1)
			expect(check.errors.join("\n")).toMatch(
				/0002_new\.sql is unsafe \(proof run: comb could not run this in the proof copy on libsql's SQLite 3\.\d+\.\d+: /,
			)
		} finally {
			project.dispose()
		}
	})

	it("proves a file that makes a vector index, and the files after it, as any other", async () => {
		const project = await appliedThen(BASE, {
			"0002_vec.sql": "CREATE INDEX t_emb ON t (libsql_vector_idx(emb));\n",
			"0003_plain.sql": "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n",
		})
		try {
			const check = await migrateCli(project.dir, ["migrate", "check", "core"])
			expect(check.code, check.errors.join("\n")).toBe(0)
			expect([...check.outputs, ...check.errors].filter((line) => line.startsWith("Proof run"))).toEqual([])
			expect((await migrateCli(project.dir, ["migrate", "apply", "core", "--yes"])).code).toBe(0)
		} finally {
			project.dispose()
		}
		const later = await appliedThen(
			{ ...BASE, "0002_vec.sql": "CREATE INDEX t_emb ON t (libsql_vector_idx(emb));\n" },
			{ "0003_col.sql": "ALTER TABLE t ADD COLUMN note TEXT;\n" },
		)
		try {
			const check = await migrateCli(later.dir, ["migrate", "check", "core"])
			expect(check.code, check.errors.join("\n")).toBe(0)
			expect([...check.outputs, ...check.errors].filter((line) => line.startsWith("Proof run"))).toEqual([])
		} finally {
			later.dispose()
		}
	})
})

describe("baseline on a libsql target replays its history on libsql's engine (SL3)", () => {
	it("baselines a database built from a history holding a vector index", async () => {
		const history = {
			"0001_t.sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, emb F32_BLOB(3));\n",
			"0002_vec.sql": "CREATE INDEX t_emb ON t (libsql_vector_idx(emb));\n",
		}
		const project = migrateProject(history)
		try {
			const client = createClient({ url: project.url })
			for (const sql of Object.values(history)) await client.execute(sql)
			client.close()
			const run = await migrateCli(project.dir, ["migrate", "baseline", "core"])
			expect(run.code, run.errors.join("\n")).toBe(0)
		} finally {
			project.dispose()
		}
	})
})
