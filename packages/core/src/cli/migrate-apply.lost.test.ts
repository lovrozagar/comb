/**
 * S3 of r21: a libsql file whose batch commits and whose answer is then lost, over http:// and
 * ws://, is reported unknown, not pending, and the next apply reads it as applied and applies the
 * rest. The loss is the real @libsql/client's own error for each transport, from a local server
 * that closes the connection mid-request, thrown after the batch commits, the link staying down
 */
import type { Client, Config, InStatement } from "@libsql/client"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { lostRequest } from "../migrate/__fixtures__/libsql-stubs.ts"
import { fakeAtlas, writeSum } from "./__fixtures__/d1.ts"
import { makeIo, projects } from "./__fixtures__/io.ts"
import { runCli } from "./run.ts"

/* the batch whose answer is lost once it commits, and the error the link then fails each call with */
const lose: { error?: unknown; file?: string } = {}

vi.mock("@libsql/client", async (original) => {
	const libsql = await original<typeof import("@libsql/client")>()
	return {
		...libsql,
		createClient: (config: Config): Client => {
			const client = libsql.createClient(config)
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

/** A project with comb.migrate.config.ts over a libsql file, and three migrations in ./m */
function configured(): string {
	const dir = temp.make()
	mkdirSync(join(dir, "m"))
	for (const name of ["0001_t1", "0002_t2", "0003_t3"])
		writeFileSync(join(dir, "m", `${name}.sql`), `CREATE TABLE ${name.slice(5)} (a);\n`)
	writeSum(join(dir, "m"))
	writeFileSync(
		join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", name: "core-dev", provider: { type: "libsql", url: ${JSON.stringify(`file:${join(dir, "core.db")}`)} } } } }\n`,
	)
	return dir
}

/** `migrate <mode> core --json` in `dir`: its exit and its report */
async function run(dir: string, mode: "apply" | "status"): Promise<[number, unknown]> {
	const io = makeIo(dir, fakeAtlas())
	const exit = await runCli(["migrate", mode, "core", "--json", ...(mode === "apply" ? ["--yes"] : [])], io)
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
