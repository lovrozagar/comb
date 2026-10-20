/**
 * The cascade-rebuild scenario (support/rebuild-guard.ts) on a local D1, where foreign keys are
 * always on: each migration applies through `wrangler d1 migrations apply --local`, as comb
 * applies D1 migrations, and the rows are read from the local database file between runs.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { createClient } from "@libsql/client"
import { expect, it } from "vitest"
import { describeAtlas } from "../support/atlas.ts"
import { type Engine, history, runScenario, SOUND } from "../support/rebuild-guard.ts"

const WRANGLER = path.join(
	path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
	"bin/wrangler.js",
)

/** A wrangler project with one D1 database whose migrations directory is `migrations` */
function project(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-d1-rebuild-"))
	fs.writeFileSync(
		path.join(dir, "wrangler.toml"),
		'name = "probe"\ncompatibility_date = "2026-10-01"\n\n[[d1_databases]]\nbinding = "CORE"\ndatabase_name = "core"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\nmigrations_dir = "migrations"\n',
	)
	fs.mkdirSync(path.join(dir, "migrations"))
	return dir
}

/** The local D1 database file wrangler keeps for the project */
function databaseFile(dir: string): string {
	const state = path.join(dir, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject")
	const file = fs.readdirSync(state).find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
	return path.join(state, file as string)
}

/** D1 through wrangler: a migration applies with `d1 migrations apply`; rows are read from the file in between */
function d1Engine(dir: string): Engine {
	const open = async <T>(use: (client: ReturnType<typeof createClient>) => Promise<T>) => {
		const client = createClient({ url: `file:${databaseFile(dir)}` })
		try {
			return await use(client)
		} finally {
			client.close()
		}
	}
	return {
		apply: async () => {
			const ran = spawnSync(process.execPath, [WRANGLER, "d1", "migrations", "apply", "core", "--local"], {
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			})
			if (ran.status !== 0) throw new Error(`wrangler d1 migrations apply failed: ${ran.stdout}${ran.stderr}`)
		},
		rows: (sql) => open(async (client) => (await client.execute(sql)).rows.map((row) => ({ ...row }))),
		run: (sql) => open(async (client) => void (await client.executeMultiple(sql))),
	}
}

describeAtlas("the guard around Atlas's rebuild of a referenced table, on D1 through wrangler", () => {
	it("keeps every row, key, rowid, sequence and index entry through a rebuild of the parent, then of parent and child", async () => {
		const dir = project()
		try {
			const { both, parent } = await runScenario(d1Engine(dir), history(path.join(dir, "migrations")))
			for (const outcome of [parent, both]) {
				expect(outcome.after).toEqual(outcome.before)
				expect(outcome.sound).toEqual(SOUND)
				expect(outcome.safety).toBe("cautious")
			}
		} finally {
			fs.rmSync(dir, { force: true, recursive: true })
		}
	}, 180_000)
})
