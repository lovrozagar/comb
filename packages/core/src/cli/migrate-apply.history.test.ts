/**
 * comb's own SQLite history records each file's name beside its hash (M10): an applied file edited
 * since was taken for a new one, and apply ran it again.
 */
import { createClient } from "@libsql/client"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
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

/** comb 0.12's history over `url`: hash unique, each row named as 0.12 named it, the AUTOINCREMENT counter at `seq` */
async function history012(
	url: string,
	{ recorded, seq = 0, setup }: { recorded: Array<[number, string, string]>; seq?: number; setup: string },
) {
	const client = createClient({ url })
	try {
		await client.executeMultiple(
			`${setup}\nCREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, name TEXT);`,
		)
		for (const [id, sql, name] of recorded)
			await client.execute({
				args: [id, migrationHashes(sql)[0] as string, name],
				sql: "INSERT INTO __drizzle_migrations (id, hash, created_at, name) VALUES (?, ?, 1, ?)",
			})
		if (seq > 0)
			await client.execute({
				args: [seq],
				sql: "UPDATE sqlite_sequence SET seq = ? WHERE name = '__drizzle_migrations'",
			})
	} finally {
		client.close()
	}
}

const A = "CREATE TABLE a (id INTEGER PRIMARY KEY);"
const B = "CREATE TABLE b (id INTEGER PRIMARY KEY);"
const LONE = "CREATE TABLE lone (id INTEGER PRIMARY KEY);"
const names = async (url: string) => (await rows(url, "SELECT name FROM __drizzle_migrations ORDER BY id")).flat()

/* M35 of the 0.13 review: a 0.12 history's named rows, resolved once to the files they name */
describe("comb's SQLite history from 0.12, its named rows resolved (M35)", () => {
	it("takes a row 0.12 recorded for a --file outside the directory as one, in check, status and apply", async () => {
		const { dir, url } = configured({ "1_a.sql": A })
		await history012(url, {
			recorded: [
				[1, A, "1_a.sql"],
				[2, LONE, "lone.sql"],
			],
			setup: `${A}\n${LONE}`,
		})
		expect(await runCli(["migrate", "check", "core"], makeIo(dir, fakeAtlas()))).toBe(0)
		const status = makeIo(dir, fakeAtlas())
		expect(await runCli(["migrate", "status", "core"], status)).toBe(0)
		expect(status.outputs).toEqual(["Applied: 1_a.sql", "Pending: none"])
		expect(await runCli(["migrate", "apply", "core"], makeIo(dir, fakeAtlas()))).toBe(0)
		expect(await names(url)).toEqual(["1_a.sql", "../lone.sql"])
	})

	it("names a row by the one file that holds its hash, so a file renamed under 0.12 does not run again", async () => {
		const { dir, url } = configured({ "1_a.sql": A, "2_b_renamed.sql": B })
		await history012(url, {
			recorded: [
				[1, A, "1_a.sql"],
				[2, B, "2_b.sql"],
			],
			setup: `${A}\n${B}`,
		})
		const check = makeIo(dir, fakeAtlas())
		expect(await runCli(["migrate", "check", "core"], check), check.errors.join("\n")).toBe(0)
		expect(check.outputs.at(-1)).toBe("\nCheck passed: 0 pending")
		const apply = makeIo(dir, fakeAtlas())
		expect(await runCli(["migrate", "apply", "core"], apply)).toBe(0)
		expect(apply.outputs.filter((line) => line.startsWith("Apply:"))).toEqual([])
		expect(await names(url)).toEqual(["1_a.sql", "2_b_renamed.sql"])
	})

	it("takes a row for a file deleted under 0.12 as one from outside the directory, as 0.12 could not tell either", async () => {
		const { dir, url } = configured({ "1_a.sql": A })
		await history012(url, {
			recorded: [
				[1, A, "1_a.sql"],
				[2, B, "2_gone.sql"],
			],
			setup: `${A}\n${B}`,
		})
		expect(await runCli(["migrate", "apply", "core"], makeIo(dir, fakeAtlas()))).toBe(0)
		expect(await names(url)).toEqual(["1_a.sql", "../2_gone.sql"])
	})
})

describe("comb's SQLite history from 0.12: what stays refused (M35)", () => {
	it("refuses a row whose hash two unrecorded files hold, naming them", async () => {
		const { dir, url } = configured({ "1_a.sql": A, "2_x.sql": B, "3_y.sql": B })
		await history012(url, {
			recorded: [
				[1, A, "1_a.sql"],
				[2, B, "2_b.sql"],
			],
			setup: `${A}\n${B}`,
		})
		for (const mode of ["check", "status", "apply"]) {
			const io = makeIo(dir, fakeAtlas())
			expect(await runCli(["migrate", mode, "core"], io)).toBe(1)
			expect(io.errors.join("\n")).toMatch(/2_b\.sql.*2_x\.sql, 3_y\.sql/)
		}
	})

	it("holds every row strictly once 0.13 rebuilt the history: a file renamed after is refused", async () => {
		const { dir, url, write } = configured({ "1_a.sql": A })
		await history012(url, { recorded: [[1, A, "1_a.sql"]], setup: A })
		expect(await runCli(["migrate", "apply", "core"], makeIo(dir, fakeAtlas()))).toBe(0)
		rmSync(join(dir, "m", "1_a.sql"))
		write({ "1_a_renamed.sql": A })
		const check = makeIo(dir, fakeAtlas())
		expect(await runCli(["migrate", "check", "core"], check)).toBe(1)
		expect(check.errors.join("\n")).toMatch(/matches no file in .* \(1_a\.sql\)/)
	})
})

/* M36 of the 0.13 review: the rebuild keeps the history's AUTOINCREMENT counter, so no id is used twice */
describe("comb's SQLite history from 0.12, rebuilt (M36)", () => {
	it("keeps the AUTOINCREMENT counter above every id it handed out", async () => {
		const { dir, url } = configured({ "1_a.sql": A })
		await history012(url, { recorded: [[1, A, "1_a.sql"]], setup: A, seq: 7 })
		expect(await runCli(["migrate", "apply", "core"], makeIo(dir, fakeAtlas()))).toBe(0)
		expect(await rows(url, "SELECT seq FROM sqlite_sequence WHERE name = '__drizzle_migrations'")).toEqual([[7]])
	})

	it("starts the counter at the largest id of a history made without AUTOINCREMENT", async () => {
		const { dir, url } = configured({ "1_a.sql": A })
		const client = createClient({ url })
		await client.executeMultiple(
			`${A}\nCREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, name TEXT);\nINSERT INTO __drizzle_migrations VALUES (4, '${migrationHashes(A)[0] as string}', 1, '1_a.sql');`,
		)
		client.close()
		expect(await runCli(["migrate", "apply", "core"], makeIo(dir, fakeAtlas()))).toBe(0)
		expect(await rows(url, "SELECT seq FROM sqlite_sequence WHERE name = '__drizzle_migrations'")).toEqual([[4]])
	})
})

/* M34 of the 0.13 review: a whole-directory run reads only the directory's top level */
describe("migrate apply --file in a subdirectory of the migrations directory (M34)", () => {
	it("is refused up front, as no later whole-directory run would read it", async () => {
		const { dir, url } = configured({ "1_a.sql": A })
		mkdirSync(join(dir, "m", "manual"))
		writeFileSync(join(dir, "m", "manual", "fix.sql"), B)
		const io = makeIo(dir, fakeAtlas())
		expect(await runCli(["migrate", "apply", "core", "--file", "m/manual/fix.sql"], io)).toBe(1)
		expect(io.errors.join("\n")).toMatch(
			/m\/manual\/fix\.sql is in a subdirectory of .*\/m, which a whole-directory run does not read/,
		)
		expect(await rows(url, "SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'")).toEqual([])
	})
})

/* M42 of the 0.13 review: a view or trigger over the history moves through the rebuild with it */
describe("comb's SQLite history from 0.12 with a view and a trigger over it, rebuilt (M42)", () => {
	it("applies, and keeps the view and the trigger working on the rebuilt history", async () => {
		const { dir, url, write } = configured({ "1_a.sql": A })
		await history012(url, {
			recorded: [[1, A, "1_a.sql"]],
			setup: `${A}\nCREATE TABLE seen (name TEXT);`,
		})
		const client = createClient({ url })
		await client.executeMultiple(
			"CREATE VIEW last_migration AS SELECT name FROM __drizzle_migrations ORDER BY id DESC LIMIT 1;\nCREATE TRIGGER noted AFTER INSERT ON __drizzle_migrations BEGIN INSERT INTO seen VALUES (new.name); END;",
		)
		client.close()
		write({ "2_b.sql": B })
		const apply = makeIo(dir, fakeAtlas())
		expect(await runCli(["migrate", "apply", "core"], apply), apply.errors.join("\n")).toBe(0)
		expect(await rows(url, "SELECT name FROM last_migration")).toEqual([["2_b.sql"]])
		expect(await rows(url, "SELECT name FROM seen")).toEqual([["2_b.sql"]])
	})

	it("keeps an index made on the history", async () => {
		const { dir, url } = configured({ "1_a.sql": A })
		await history012(url, { recorded: [[1, A, "1_a.sql"]], setup: A })
		const client = createClient({ url })
		await client.execute("CREATE INDEX by_created ON __drizzle_migrations (created_at)")
		client.close()
		expect(await runCli(["migrate", "apply", "core"], makeIo(dir, fakeAtlas()))).toBe(0)
		expect(await rows(url, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'by_created'")).toEqual([
			["by_created"],
		])
	})

	it("refuses, naming the view, and changes nothing, when a view over the history cannot come back", async () => {
		const { dir, url, write } = configured({ "1_a.sql": A })
		const client = createClient({ url })
		await client.executeMultiple(
			`${A}\nCREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, name TEXT, note TEXT);\nINSERT INTO __drizzle_migrations VALUES (1, '${migrationHashes(A)[0] as string}', 1, '1_a.sql', 'kept');\nCREATE VIEW notes AS SELECT note FROM __drizzle_migrations;`,
		)
		client.close()
		write({ "2_b.sql": B })
		const apply = makeIo(dir, fakeAtlas())
		expect(await runCli(["migrate", "apply", "core"], apply)).toBe(1)
		expect(apply.errors.join("\n")).toMatch(
			/could not rebuild __drizzle_migrations for 0\.13 with the view notes over it, and changed nothing/,
		)
		expect(await rows(url, "SELECT note FROM notes")).toEqual([["kept"]])
	})
})
