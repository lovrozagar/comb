/**
 * S1 of r22 through the real CLI against the pinned sqld (tests/support/sqld.ts), over http:// and
 * ws://: what the server refuses at parse is refused at check, with its approval, before anything
 * applies; and a sqld target's files apply through the one client the command writes with.
 */
import { createClient } from "@libsql/client"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type Sqld, startSqld } from "../../support/sqld.ts"
import { migrateCli, type MigrateProject, migrateProject } from "../support/migrate-project.ts"

const opened = vi.hoisted(() => ({ urls: [] as string[] }))
vi.mock("@libsql/client", async (original) => {
	const real = await original<typeof import("@libsql/client")>()
	return {
		...real,
		createClient: (config: Parameters<typeof real.createClient>[0]) => {
			opened.urls.push(config.url)
			return real.createClient(config)
		},
	}
})

/* sqld serves one database, so each case gets a server of its own and no history meets another case's */
let server: Sqld
beforeEach(async () => {
	server = await startSqld()
})
afterEach(async () => {
	await server.stop()
})

/** A project on its own database of the server, over `scheme`, with 0001 applied and a row in t */
async function applied(scheme: "http" | "ws", db: string): Promise<MigrateProject> {
	const url = scheme === "http" ? server.http : server.ws
	const project = migrateProject(
		{ [`0001_${db}.sql`]: `CREATE TABLE ${db} (id INTEGER PRIMARY KEY, v TEXT);\n` },
		{ url },
	)
	expect((await migrateCli(project.dir, ["migrate", "apply", "core", "--yes"])).code).toBe(0)
	const client = createClient({ url: server.http })
	await client.execute(`INSERT INTO ${db} (v) VALUES ('x')`)
	client.close()
	return project
}

function add(project: MigrateProject, files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(project.migrationsDir, name), sql)
	spawnSync("atlas", ["migrate", "hash", "--dir", `file://${project.migrationsDir}`])
}

async function history(): Promise<unknown[]> {
	const client = createClient({ url: server.http })
	try {
		return (await client.execute("SELECT name FROM __drizzle_migrations ORDER BY id")).rows.map((row) => row[0])
	} finally {
		client.close()
	}
}

describe.each(["http", "ws"] as const)(
	"a sqld target over %s:// refuses at check what sqld refuses (S1 of r22; sibling: D1's gate)",
	(scheme) => {
		it.each([
			[
				"an approved legacy_alter_table rename (r22's 0003)",
				"-- comb:allow-unsafe: keep the views' old references as written\nPRAGMA legacy_alter_table = ON;\nALTER TABLE {t} RENAME TO {t}_2;\n",
			],
			[
				"an approved ANALYZE",
				"-- comb:allow-unsafe: refresh the planner's statistics\nCREATE INDEX {t}_v ON {t} (v);\nANALYZE;\n",
			],
		])("refuses %s at check and at apply, naming the server, and applies nothing", async (_, text) => {
			const db = `s1_${scheme}`
			const project = await applied(scheme, db)
			try {
				const before = await history()
				add(project, { [`0002_${db}.sql`]: text.replaceAll("{t}", db) })
				for (const mode of ["check", "apply"]) {
					const run = await migrateCli(project.dir, ["migrate", mode, "core", "--yes"])
					expect(run.code, mode).toBe(1)
					expect(run.errors.join("\n"), mode).toMatch(/libsql server \(sqld\)/)
				}
				expect(await history()).toEqual(before)
			} finally {
				project.dispose()
			}
		})
	},
)

describe("a sqld apply writes through one client (S1 of r22's amendment; sibling: a local libsql file's connection per file, r21 S1)", () => {
	it("applies three files through the writer comb's history uses: one reader and one writer in all", async () => {
		const db = "one"
		const project = await applied("ws", db)
		try {
			add(project, {
				[`0002_${db}.sql`]: `CREATE TABLE ${db}_a (x INTEGER);\n`,
				[`0003_${db}.sql`]: `CREATE TABLE ${db}_b (x INTEGER);\n`,
				[`0004_${db}.sql`]: `CREATE TABLE ${db}_c (x INTEGER);\n`,
			})
			opened.urls.length = 0
			const run = await migrateCli(project.dir, ["migrate", "apply", "core", "--yes"])
			expect(run.code, run.errors.join("\n")).toBe(0)
			expect(run.outputs).toContain("\nDone: 3 applied, 1 skipped")
			expect(opened.urls).toEqual([server.ws, server.ws])
		} finally {
			project.dispose()
		}
	})
})
