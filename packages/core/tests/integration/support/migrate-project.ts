/** A migrate project on a real SQLite file, and the CLI run on it: the libsql migrate suites' harness */
import { createClient } from "@libsql/client"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCli } from "../../../src/cli/index.ts"

export type MigrateProject = { dir: string; migrationsDir: string; url: string; dispose(): void }

/** A project whose core database is `local.db`, holding `migrations` in `m/`, hashed */
export function migrateProject(migrations: Record<string, string>): MigrateProject {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-migrate-"))
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
	return { dir, dispose: () => fs.rmSync(dir, { force: true, recursive: true }), migrationsDir, url }
}

/** The CLI's exit code, stdout and stderr lines for `args` on the local environment, run in `dir` */
export async function migrateCli(dir: string, args: readonly string[]) {
	const errors: string[] = []
	const outputs: string[] = []
	const code = await runCli([...args, "-e", "local"], {
		cwd: dir,
		err: (line) => errors.push(line),
		out: (line) => outputs.push(line),
	})
	return { code, errors, outputs }
}

/** The rows `sql` reads from the database at `url`, each as its values */
export async function sqliteRows(url: string, sql: string): Promise<unknown[][]> {
	const client = createClient({ url })
	try {
		return (await client.execute(sql)).rows.map((row) => Object.values(row))
	} finally {
		client.close()
	}
}
