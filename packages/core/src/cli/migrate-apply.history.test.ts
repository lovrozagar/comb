/**
 * comb's own SQLite history records each file's name beside its hash (M10): an applied file edited
 * since was taken for a new one, and apply ran it again.
 */
import { createClient } from "@libsql/client"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { migrationHashes } from "../migrate/core/parse.ts"
import { fakeAtlas, writeSum } from "./__fixtures__/d1.ts"
import { makeIo, projects } from "./__fixtures__/io.ts"
import { runCli } from "./run.ts"

const temp = projects()
afterEach(temp.clean)

/** A project over a libsql file with these migrations in ./m; `write` replaces them later */
function configured(migrations: Record<string, string>) {
	const dir = temp.make()
	const url = `file:${join(dir, "core.db")}`
	const write = (files: Record<string, string>) => {
		for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, "m", name), sql)
		writeSum(join(dir, "m"))
	}
	mkdirSync(join(dir, "m"))
	write(migrations)
	writeFileSync(
		join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", name: "core-dev", provider: { type: "libsql", url: ${JSON.stringify(url)} } } } }\n`,
	)
	return { dir, url, write }
}

async function rows(url: string, sql: string): Promise<unknown[][]> {
	const client = createClient({ url })
	try {
		const result = await client.execute(sql)
		return result.rows.map((row) => result.columns.map((_, at) => row[at]))
	} finally {
		client.close()
	}
}

const SEED = "INSERT INTO plans (name) VALUES ('pro');"
const INIT = "CREATE TABLE plans (id INTEGER PRIMARY KEY, name TEXT);"

describe("comb's SQLite history and an applied file edited since (M10)", () => {
	it("records each file's name, and refuses an applied file edited since, in apply, check and status", async () => {
		const { dir, url, write } = configured({ "1_init.sql": INIT, "2_seed.sql": SEED })
		expect(await runCli(["migrate", "apply", "core", "--yes"], makeIo(dir, fakeAtlas()))).toBe(0)
		expect(await rows(url, "SELECT name FROM __drizzle_migrations ORDER BY id")).toEqual([
			["1_init.sql"],
			["2_seed.sql"],
		])
		write({ "2_seed.sql": SEED.replace("'pro'", "'Pro'") })
		for (const mode of ["apply", "check", "status"]) {
			const io = makeIo(dir, fakeAtlas())
			expect(await runCli(["migrate", mode, "core", ...(mode === "apply" ? ["--yes"] : [])], io)).toBe(1)
			expect(io.errors.join("\n")).toMatch(/2_seed\.sql was applied, then edited: its hash is not the one recorded/)
		}
		expect(await rows(url, "SELECT name FROM plans")).toEqual([["pro"]])
	})

	it("names the rows a history from before 0.11 holds, by their hashes, on the next apply", async () => {
		const { dir, url } = configured({ "1_init.sql": INIT })
		const client = createClient({ url })
		await client.executeMultiple(
			`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL); ${INIT}`,
		)
		await client.execute({
			args: [migrationHashes(INIT)[0] as string, 1],
			sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
		})
		client.close()
		expect(await runCli(["migrate", "apply", "core"], makeIo(dir, fakeAtlas()))).toBe(0)
		expect(await rows(url, "SELECT name FROM __drizzle_migrations")).toEqual([["1_init.sql"]])
	})
})

/** A history from before 0.11 holding both files unnamed, its tables made */
const unnamedHistory = async (url: string) => {
	const client = createClient({ url })
	await client.executeMultiple(
		`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL); ${INIT} ${SEED}`,
	)
	for (const sql of [INIT, SEED])
		await client.execute({
			args: [migrationHashes(sql)[0] as string, 1],
			sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
		})
	client.close()
}

/* M15 and M16 of the 0.12 round: a recorded row is matched to one file, by its name, or, unnamed, by its hash */
describe("comb's SQLite history and a row that matches no file, or a file whose text another had (M15, M16)", () => {
	it("refuses an unnamed row whose file was edited since, in apply and check, and names it in status (M15)", async () => {
		const { dir, url, write } = configured({ "1_init.sql": INIT, "2_seed.sql": SEED })
		await unnamedHistory(url)
		write({ "2_seed.sql": SEED.replace("'pro'", "'Pro'") })
		for (const mode of ["apply", "check"]) {
			const io = makeIo(dir, fakeAtlas())
			expect(await runCli(["migrate", mode, "core", ...(mode === "apply" ? ["--yes"] : [])], io)).toBe(1)
			expect(io.errors.join("\n")).toMatch(
				/1 applied migration matches no file in .*: one was edited or renamed after it was applied/,
			)
		}
		const status = makeIo(dir, fakeAtlas())
		expect(await runCli(["migrate", "status", "core"], status)).toBe(0)
		expect(status.outputs.join("\n")).toMatch(/1 applied migration matches no file/)
		expect(await rows(url, "SELECT name FROM plans")).toEqual([["pro"]])
	})

	it("refuses a named row whose file was renamed and edited (M15)", async () => {
		const { dir, url } = configured({ "1_init.sql": INIT, "2_seed.sql": SEED })
		expect(await runCli(["migrate", "apply", "core", "--yes"], makeIo(dir, fakeAtlas()))).toBe(0)
		const moved = join(dir, "m")
		const { renameSync, writeFileSync: write } = await import("node:fs")
		renameSync(join(moved, "2_seed.sql"), join(moved, "2_seed_v2.sql"))
		write(join(moved, "2_seed_v2.sql"), SEED.replace("'pro'", "'Pro'"))
		writeSum(moved)
		const io = makeIo(dir, fakeAtlas())
		expect(await runCli(["migrate", "apply", "core", "--yes"], io)).toBe(1)
		expect(io.errors.join("\n")).toMatch(/matches no file in .*\(2_seed\.sql\)/)
		expect(await rows(url, "SELECT name FROM plans")).toEqual([["pro"]])
	})
})

describe("comb's SQLite history and two files of one text (M16)", () => {
	it("runs a file whose text normalizes to an applied file's: each row matches one file (M16)", async () => {
		const index = "CREATE INDEX plans_name ON plans (name);"
		const { dir, url, write } = configured({
			"1_init.sql": INIT,
			"2_index.sql": index,
			"3_drop.sql": "DROP INDEX plans_name;",
		})
		expect(await runCli(["migrate", "apply", "core", "--yes"], makeIo(dir, fakeAtlas()))).toBe(0)
		write({ "4_readd.sql": `-- the index is needed again\n${index}` })
		const status = makeIo(dir, fakeAtlas())
		expect(await runCli(["migrate", "status", "core"], status)).toBe(0)
		expect(status.outputs.join("\n")).toContain("Pending: 4_readd.sql")
		expect(await runCli(["migrate", "apply", "core", "--yes"], makeIo(dir, fakeAtlas()))).toBe(0)
		expect(await rows(url, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'plans_name'")).toEqual([
			["plans_name"],
		])
	})
})
