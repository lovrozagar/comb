/**
 * SL5 of r22 (sibling: migrate-cli's pre-0.5.0 hash): SQLite skips only space, tab, newline, form feed and
 * return, so `a b` is column a of type b while `a`, a no-break space and `b` is one column named that. A row
 * this comb records holds the exact hash and `hash_v`, so a file applied with either space and edited to the
 * other is edited. A row comb 0.20 recorded, every space folded and no `hash_v`, still matches its file, and
 * the file edited to a space its fold equates, on any date; check reads such a history and writes nothing.
 * Each case runs on a local file and on the pinned sqld.
 */
import { createClient } from "@libsql/client"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { foldedMigrationHash } from "../../../src/migrate/core/parse.ts"
import { type Sqld, startSqld } from "../../support/sqld.ts"
import { migrateCli, type MigrateProject, migrateProject, sqliteRows } from "../support/migrate-project.ts"

const ASCII = "CREATE TABLE t (id INTEGER PRIMARY KEY, a b);\n"
const UNICODE = "CREATE TABLE t (id INTEGER PRIMARY KEY, a\u00a0b);\n"

/* comb 0.20.1's history table and its record of an applied file, as that version wrote them */
const TABLE_0_20 =
	"CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER NOT NULL, name TEXT UNIQUE)"
const RECORD_0_20 = "INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)"

let server: Sqld | undefined
afterEach(async () => {
	await server?.stop()
	server = undefined
})

const TARGETS = {
	file: async () => undefined,
	sqld: async () => {
		server = await startSqld()
		return { url: server.http }
	},
} as const

/** `file` written into the project's directory as 1_t.sql, its sum rehashed */
function edit(project: MigrateProject, file: string): void {
	fs.writeFileSync(path.join(project.migrationsDir, "1_t.sql"), file)
	spawnSync("atlas", ["migrate", "hash", "--dir", `file://${project.migrationsDir}`])
}

/** The project's database as comb 0.20.1 left it after applying `applied`, which it recorded under its folded hash */
async function appliedBy020(project: MigrateProject, applied: string, createdAt: number): Promise<void> {
	const client = createClient({ url: project.url })
	try {
		await client.batch([
			applied,
			TABLE_0_20,
			{ args: [foldedMigrationHash(applied), createdAt, "1_t.sql"], sql: RECORD_0_20 },
		])
	} finally {
		client.close()
	}
}

const columns = (project: MigrateProject) =>
	sqliteRows(project.url, "SELECT name FROM pragma_table_info('__drizzle_migrations')")

describe.each(Object.keys(TARGETS) as Array<keyof typeof TARGETS>)(
	"migrate status and check on a file holding a space SQLite reads as part of a name, on %s",
	(target) => {
		it.each([
			["such a space, then edited to a plain one", UNICODE, ASCII],
			["a plain space, then edited to such a one", ASCII, UNICODE],
		])(
			"refuses a file this comb applied with %s",
			async (_, applied, edited) => {
				const project = migrateProject({ "1_t.sql": applied }, await TARGETS[target]())
				try {
					expect((await migrateCli(project.dir, ["migrate", "apply", "core"])).code).toBe(0)
					edit(project, edited)
					for (const command of ["status", "check"]) {
						const run = await migrateCli(project.dir, ["migrate", command, "core"])
						expect(run.code).toBe(1)
						expect(run.errors.join("\n")).toContain("1_t.sql was applied, then edited")
					}
				} finally {
					project.dispose()
				}
			},
			60_000,
		)

		it.each([
			["the file it applied, holding such a space", UNICODE, UNICODE],
			["a file it applied with a plain space, edited to such a one", ASCII, UNICODE],
		])(
			"accepts on a row comb 0.20.1 recorded, on any date, %s, and check writes nothing",
			async (_, applied, file) => {
				const project = migrateProject({ "1_t.sql": file }, await TARGETS[target]())
				try {
					await appliedBy020(project, applied, Date.parse("2027-01-01T00:00:00Z"))
					const before = await sqliteRows(project.url, "SELECT * FROM __drizzle_migrations")
					for (const command of ["status", "check"]) {
						const run = await migrateCli(project.dir, ["migrate", command, "core"])
						expect(run.code, run.errors.join("\n")).toBe(0)
					}
					expect(await columns(project)).toEqual([["id"], ["hash"], ["created_at"], ["name"]])
					expect(await sqliteRows(project.url, "SELECT * FROM __drizzle_migrations")).toEqual(before)
				} finally {
					project.dispose()
				}
			},
			60_000,
		)
	},
)

describe.each(Object.keys(TARGETS) as Array<keyof typeof TARGETS>)(
	"migrate apply over a history comb 0.20.1 recorded, on %s",
	(target) => {
		it("marks what apply records on a 0.20.1 history, and still accepts the row 0.20.1 recorded", async () => {
			const files = { "1_t.sql": UNICODE, "2_u.sql": "CREATE TABLE u (id INTEGER PRIMARY KEY);\n" }
			const project = migrateProject(files, await TARGETS[target]())
			try {
				await appliedBy020(project, ASCII, 1)
				const apply = await migrateCli(project.dir, ["migrate", "apply", "core"])
				expect(apply.code, apply.errors.join("\n")).toBe(0)
				expect(await sqliteRows(project.url, "SELECT name, hash_v FROM __drizzle_migrations ORDER BY id")).toEqual([
					["1_t.sql", null],
					["2_u.sql", 2],
				])
				expect((await migrateCli(project.dir, ["migrate", "check", "core"])).code).toBe(0)
			} finally {
				project.dispose()
			}
		}, 60_000)
	},
)
