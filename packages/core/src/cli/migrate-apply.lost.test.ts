/**
 * S3 of r21: a libsql server's batch that commits and whose answer is then lost, over http:// and
 * ws://, is reported unknown, not pending, and the next apply reads it as applied and applies the
 * rest. The loss is the real @libsql/client's own error for each transport, from a local server
 * that closes the connection mid-request, thrown after the batch commits, the link staying down.
 * The server is the project's file behind the client (SL1 of r22: a local file's own files apply
 * through libsql's Database, which no network stands between)
 */
import type { Client, Config, InStatement } from "@libsql/client"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { lostRequest } from "../migrate/__fixtures__/libsql-stubs.ts"
import { fakeAtlas, writeSum } from "./__fixtures__/d1.ts"
import { makeIo, projects, runCliWithFakes } from "./__fixtures__/io.ts"

/* the batch whose answer is lost once it commits, the error the link then fails each call with, and the file serving the server */
const lose: { db?: string; error?: unknown; file?: string } = {}
/* the project's libsql server, which the clients comb opens reach as the file lose.db; lostRequest's own reach its stub */
const SERVER = "http://lost.invalid"

vi.mock("@libsql/client", async (original) => {
	const libsql = await original<typeof import("@libsql/client")>()
	return {
		...libsql,
		createClient: (config: Config): Client => {
			const client = libsql.createClient(config.url === SERVER ? { ...config, url: `file:${lose.db}` } : config)
			let down = false
			const up = () => {
				if (down) throw lose.error
			}
			return {
				batch: async (statements: InStatement[], mode?: "write") => {
					up()
					const result = await client.batch(statements, mode)
					down = lose.file !== undefined && JSON.stringify(statements).includes(lose.file)
					up()
					return result
				},
				close: () => client.close(),
				execute: async (statement: InStatement) => {
					up()
					return client.execute(statement)
				},
			} as unknown as Client
		},
	}
})

/* the retries of the lost batch's history read, at once */
vi.mock("../migrate/core/utils.ts", async (original) => {
	const utils = await original<typeof import("../migrate/core/utils.ts")>()
	return {
		...utils,
		withRetry: <T>(fn: () => Promise<T>) => utils.withRetry(fn, { baseDelay: 0, maxDelay: 0 }),
	}
})

const temp = projects()
afterEach(() => {
	temp.clean()
	delete lose.file
})

/** A project with comb.migrate.config.ts over a libsql server, its file core.db, and three migrations in ./m */
function configured(): string {
	const dir = temp.make()
	mkdirSync(join(dir, "m"))
	for (const name of ["0001_t1", "0002_t2", "0003_t3"])
		writeFileSync(join(dir, "m", `${name}.sql`), `CREATE TABLE ${name.slice(5)} (a);\n`)
	writeSum(join(dir, "m"))
	lose.db = join(dir, "core.db")
	writeFileSync(
		join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", name: "core-dev", provider: { type: "libsql", url: ${JSON.stringify(SERVER)} } } } }\n`,
	)
	return dir
}

/** `migrate <mode> core --json` in `dir`: its exit and its report */
async function run(dir: string, mode: "apply" | "status"): Promise<[number, unknown]> {
	const io = makeIo(dir, fakeAtlas())
	const exit = await runCliWithFakes(["migrate", mode, "core", "--json", ...(mode === "apply" ? ["--yes"] : [])], io)
	return [exit, JSON.parse(io.outputs.at(-1) as string)]
}

describe("migrate apply on libsql when a committed batch's answer is lost", () => {
	it.each(["http", "ws"] as const)(
		"over %s:// reports the file unknown, and the next apply reads it as applied and applies the rest",
		async (scheme) => {
			const dir = configured()
			lose.error = await lostRequest(scheme, scheme === "ws" ? "upgraded, then closed" : "closed")
			lose.file = "0002_t2.sql"
			const [exit, report] = await run(dir, "apply")
			expect([exit, report]).toMatchObject([
				1,
				{ applied: ["0001_t1.sql"], pending: ["0003_t3.sql"], unknown: ["0002_t2.sql"] },
			])
			delete lose.file
			expect(await run(dir, "apply")).toEqual([
				0,
				{ applied: ["0003_t3.sql"], database: "core", pending: [], refused: [], unknown: [] },
			])
			expect(await run(dir, "status")).toEqual([
				0,
				{
					applied: ["0001_t1.sql", "0002_t2.sql", "0003_t3.sql"],
					database: "core",
					pending: [],
					refused: [],
					unknown: [],
				},
			])
		},
	)
})
