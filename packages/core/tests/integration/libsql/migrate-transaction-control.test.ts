/**
 * S1 of the 0.15.0 review, on a real SQLite file: a COMMIT inside a migration ended the batch that
 * applies and records the file, so a failure after it committed half the file with no history
 * row, and each later apply ran that half again. check and apply refuse the file before any of it runs.
 */
import { createClient } from "@libsql/client"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../../src/cli/index.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

/** A project whose core database is `local.db`, holding `migrations`, hashed */
function project(migrations: Record<string, string>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-migrate-txn-"))
	dirs.push(dir)
	const migrationsDir = path.join(dir, "m")
	fs.mkdirSync(migrationsDir)
	for (const [name, sql] of Object.entries(migrations)) fs.writeFileSync(path.join(migrationsDir, name), sql)
	spawnSync("atlas", ["migrate", "hash", "--dir", `file://${migrationsDir}`])
	const url = `file:${path.join(dir, "local.db")}`
	fs.writeFileSync(
		path.join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", environments: {
	local: { name: "core", provider: { type: "libsql", url: ${JSON.stringify(url)} } },
} } } }\n`,
	)
	return { dir, url }
}

/** The CLI's exit code and its stderr lines for `args` on the local environment, run in `dir` */
async function run(dir: string, args: string[]) {
	const errors: string[] = []
	const code = await runCli([...args, "-e", "local"], { cwd: dir, err: (line) => errors.push(line), out: () => {} })
	return { code, errors }
}

async function rows(url: string, sql: string) {
	const client = createClient({ url })
	try {
		return (await client.execute(sql)).rows.map((row) => Object.values(row))
	} finally {
		client.close()
	}
}

describe("migrate check and apply on a file holding a COMMIT", () => {
	it("refuses the file, so a failure after its COMMIT never commits half of it", async () => {
		const { dir, url } = project({
			"1_init.sql": "CREATE TABLE post (id INTEGER PRIMARY KEY, body TEXT);",
			"2_x.sql":
				"INSERT INTO post (body) VALUES ('x');\nCOMMIT;\nBEGIN;\nCREATE UNIQUE INDEX post_body ON post (body);\n",
		})
		expect(await run(dir, ["migrate", "apply", "core", "--file", "m/1_init.sql", "--yes"])).toEqual({
			code: 0,
			errors: [],
		})
		await rows(url, "INSERT INTO post (body) VALUES ('dup'), ('dup')")
		const check = await run(dir, ["migrate", "check", "core"])
		expect(check.code).toBe(1)
		expect(check.errors.join("\n")).toContain("comb runs each file in a transaction of its own")
		for (const _ of [1, 2]) expect((await run(dir, ["migrate", "apply", "core", "--yes"])).code).toBe(1)
		expect(await rows(url, "SELECT count(*) FROM post WHERE body = 'x'")).toEqual([[0]])
		expect(await rows(url, "SELECT count(*) FROM __drizzle_migrations")).toEqual([[1]])
	})
})
