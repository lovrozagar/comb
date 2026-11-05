/**
 * comb's migrate commands on the oldest Atlas `ATLAS_RANGE` admits (PA5 of r22): the CLI reads
 * `atlas version` before it runs anything, so on v1.2.0 it must pass that check and then status,
 * check and apply each work, on Postgres and on a SQLite file alike.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runCli } from "../../../src/cli/index.ts"
import { ATLAS_FLOOR_SHA256, ATLAS_FLOOR_VERSION, requireAtlasFloor } from "../../support/atlas-floor.ts"
import { migrateCli, migrateProject, sqliteRows } from "../support/migrate-project.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(() => {
	const bin = requireAtlasFloor()
	vi.stubEnv("PATH", `${path.dirname(bin)}${path.delimiter}${process.env.PATH ?? ""}`)
})
afterAll(() => {
	vi.unstubAllEnvs()
})

const FILES = {
	"20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n',
	"20260102000000_b.sql": 'CREATE TABLE "b" ("id" integer);\n',
}

describe("the pinned Atlas floor", () => {
	it("is the build on PATH for this file, and a missing or other binary fails the cell", () => {
		expect(spawnSync("atlas", ["version"], { encoding: "utf8" }).stdout).toContain(`version v${ATLAS_FLOOR_VERSION}`)
		const missing = path.join(os.tmpdir(), "comb-no-atlas-floor", "atlas")
		expect(() => requireAtlasFloor(missing)).toThrow(`atlas v${ATLAS_FLOOR_VERSION} is not at ${missing}`)
		const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "comb-atlas-floor-")), "atlas")
		fs.writeFileSync(other, "not atlas")
		try {
			expect(() => requireAtlasFloor(other)).toThrow(`not atlas v${ATLAS_FLOOR_VERSION}'s ${ATLAS_FLOOR_SHA256}`)
		} finally {
			fs.rmSync(path.dirname(other), { force: true, recursive: true })
		}
	})
})

/** A Postgres project in a directory of its own: `FILES` hashed in `m/`, its core database at `url` */
function pgProject(url: string, devUrl: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-atlas-floor-pg-"))
	fs.mkdirSync(path.join(dir, "m"))
	for (const [name, sql] of Object.entries(FILES)) fs.writeFileSync(path.join(dir, "m", name), sql)
	spawnSync("atlas", ["migrate", "hash", "--dir", `file://${path.join(dir, "m")}`])
	const provider = JSON.stringify({ devUrl, type: "postgres", url })
	fs.writeFileSync(
		path.join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", environments: { local: { provider: ${provider} } } } } }\n`,
	)
	return dir
}

async function pgTables(url: string): Promise<string[]> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		const { rows } = await client.query<{ tablename: string }>(
			"SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
		)
		return rows.map((row) => row.tablename)
	} finally {
		await client.end()
	}
}

/** The CLI's exit code and output for `args` on the local environment, run in `dir` */
async function cli(dir: string, args: readonly string[]) {
	const lines: string[] = []
	const code = await runCli([...args, "-e", "local"], {
		cwd: dir,
		err: (l) => lines.push(l),
		out: (l) => lines.push(l),
	})
	return { code, lines }
}

describe(`comb migrate on Atlas v${ATLAS_FLOOR_VERSION} (PA5)`, () => {
	it("runs status, check and apply on Postgres", async () => {
		await withScratchDb((devUrl) =>
			withScratchDb(async (url) => {
				const dir = pgProject(url, devUrl)
				try {
					expect(await cli(dir, ["migrate", "status", "core"])).toMatchObject({ code: 0 })
					expect(await cli(dir, ["migrate", "check", "core"])).toMatchObject({ code: 0 })
					expect(await cli(dir, ["migrate", "apply", "core"])).toMatchObject({ code: 0 })
					expect(await pgTables(url)).toEqual(["a", "b"])
					expect(await cli(dir, ["migrate", "apply", "core"])).toMatchObject({ code: 0 })
				} finally {
					fs.rmSync(dir, { force: true, recursive: true })
				}
			}),
		)
	})

	it("runs apply, then check and status, on a SQLite file", async () => {
		const project = migrateProject(FILES)
		try {
			expect(await migrateCli(project.dir, ["migrate", "apply", "core"])).toMatchObject({ code: 0 })
			expect(await migrateCli(project.dir, ["migrate", "check", "core"])).toMatchObject({ code: 0 })
			expect(await migrateCli(project.dir, ["migrate", "status", "core"])).toMatchObject({ code: 0 })
			const rows = await sqliteRows(project.url, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY 1")
			expect(rows.flat()).toEqual(expect.arrayContaining(["a", "b"]))
		} finally {
			project.dispose()
		}
	})
})
