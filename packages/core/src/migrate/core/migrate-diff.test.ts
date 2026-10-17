import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { generateIncrementalMigration, type MigrateDiffOptions } from "./migrate-diff.ts"
import type { Run, RunResult } from "./process.ts"

const ok = (stdout = ""): RunResult => ({ code: 0, stderr: "", stdout })
const fail = (stderr: string, code = 1): RunResult => ({ code, stderr, stdout: "" })

const NO_CHANGES = "The migration directory is synced with the desired state, no changes to be made"

const dirOf = (args: readonly string[], flag: string) =>
	(args[args.indexOf(flag) + 1] as string).replace(/^file:\/\//, "")

/** atlas.sum as the fake writes it: a hash over the sorted .sql names and contents */
function sumOf(dir: string): string {
	const files = readdirSync(dir)
		.filter((file) => file.endsWith(".sql"))
		.sort()
	const digest = createHash("sha256")
	for (const file of files) digest.update(`${file}\n${readFileSync(join(dir, file), "utf8")}\n`)
	return `h1:${digest.digest("hex")}\n`
}

type DiffCall = { dir: string; history: Record<string, string>; name: string; target: string }

type FakeAtlas = Run & { calls: string[][] }

/**
 * A model of the atlas CLI: `migrate hash` writes the dir's atlas.sum, `migrate diff` hands the
 * replayed directory, the migration name and the target schema to `onDiff`, which may write the
 * new migration into the directory and returns what atlas would.
 */
function fakeAtlas(onDiff: (call: DiffCall) => RunResult = () => ok(), hashResult?: () => RunResult): FakeAtlas {
	const calls: string[][] = []
	const fake = (_cmd: string, args: readonly string[]) => {
		calls.push([...args])
		const dir = dirOf(args, "--dir")
		if (args[1] === "hash") {
			const result = hashResult?.() ?? ok()
			if (result.code === 0) writeFileSync(join(dir, "atlas.sum"), sumOf(dir))
			return result
		}
		const history = Object.fromEntries(
			readdirSync(dir)
				.filter((file) => file.endsWith(".sql"))
				.map((file) => [file, readFileSync(join(dir, file), "utf8")]),
		)
		return onDiff({ dir, history, name: args[2] as string, target: readFileSync(dirOf(args, "--to"), "utf8") })
	}
	return Object.assign(fake, { calls })
}

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-migrate-diff-test-"))
})
afterEach(() => {
	rmSync(dir, { force: true, recursive: true })
})

const options = (run: Run, more: Partial<MigrateDiffOptions> = {}): MigrateDiffOptions => ({
	dialect: "sqlite",
	migrationName: "add_b",
	migrationsDir: dir,
	run,
	targetSchema: "T",
	...more,
})

/** A history of one migration, hashed the way atlas would have */
function seed(sql: string): void {
	writeFileSync(join(dir, "20260101000000_init.sql"), sql)
	writeFileSync(join(dir, "atlas.sum"), sumOf(dir))
}

const FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(name, content='items', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
	INSERT INTO items_fts(rowid, name) VALUES (new.rowid, new.name);
END;`

describe("generateIncrementalMigration", () => {
	it("hashes a directory without atlas.sum, then writes the new migration with the SQLite transforms", () => {
		const run = fakeAtlas(({ dir: replayed, target }) => {
			expect(target).toBe("T")
			writeFileSync(
				join(replayed, "20261017_add_b.sql"),
				"PRAGMA foreign_keys = off;\nCREATE TABLE b (x);\nPRAGMA foreign_keys = on;\n",
			)
			return ok()
		})
		const result = generateIncrementalMigration(options(run))
		expect(result).toEqual({ files: [join(dir, "20261017_add_b.sql")], synced: false })
		expect(readFileSync(join(dir, "20261017_add_b.sql"), "utf8")).toBe(
			"PRAGMA defer_foreign_keys = on;\nCREATE TABLE b (x);\n",
		)
		expect(readFileSync(join(dir, "atlas.sum"), "utf8")).toBe(sumOf(dir))
		expect(run.calls.map((call) => call.slice(0, 2).join(" "))).toEqual([
			"migrate hash",
			"migrate hash",
			"migrate hash",
			"migrate diff",
			"migrate hash",
		])
		expect(run.calls[3]).toContain("--dev-url")
	})

	it("skips the hash when atlas.sum exists and reports synced when nothing new appears", () => {
		seed("CREATE TABLE a (x);")
		const run = fakeAtlas(() => ({ code: 0, stderr: "", stdout: NO_CHANGES }))
		expect(generateIncrementalMigration(options(run))).toEqual({ files: [], synced: true })
		/* the integrity check and the replayed copy are hashed; the directory itself is not */
		expect(run.calls.filter((call) => call[1] === "hash")).toHaveLength(2)
	})

	it("reports synced when atlas exits 0 and writes nothing", () => {
		seed("CREATE TABLE a (x);")
		expect(generateIncrementalMigration(options(fakeAtlas()))).toEqual({ files: [], synced: true })
	})

	it("creates the migrations directory when it is missing", () => {
		const missing = join(dir, "nested", "migrations")
		expect(generateIncrementalMigration(options(fakeAtlas(), { migrationsDir: missing }))).toEqual({
			files: [],
			synced: true,
		})
		expect(existsSync(join(missing, "atlas.sum"))).toBe(true)
	})

	it("copies every file atlas adds, the first carrying the migration", () => {
		const run = fakeAtlas(({ dir: replayed }) => {
			writeFileSync(join(replayed, "20261017_a.sql"), "CREATE TABLE a (x);\n")
			writeFileSync(join(replayed, "20261017_b.sql"), "CREATE TABLE b (x);\n")
			return ok()
		})
		const { files } = generateIncrementalMigration(options(run))
		expect(files).toEqual([join(dir, "20261017_a.sql"), join(dir, "20261017_b.sql")])
		expect(readFileSync(join(dir, "20261017_b.sql"), "utf8")).toBe("CREATE TABLE b (x);\n")
	})
})

describe("generateIncrementalMigration — FTS kept out of what atlas sees (S-12)", () => {
	it("replays a history with its FTS statements stripped, and diffs a target without them", () => {
		seed(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);\n${FTS}`)
		const run = fakeAtlas(({ history, target }) => {
			expect(Object.values(history).join("")).not.toMatch(/fts5|items_fts/)
			expect(target).toBe("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);")
			return { code: 0, stderr: "", stdout: NO_CHANGES }
		})
		const result = generateIncrementalMigration(
			options(run, { ftsSql: FTS, targetSchema: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);" }),
		)
		expect(result).toEqual({ files: [], synced: true })
	})

	it("writes a timestamped migration holding only the FTS delta when atlas has no changes", () => {
		seed("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);")
		const run = fakeAtlas(() => ({ code: 0, stderr: "", stdout: NO_CHANGES }))
		const { files, synced } = generateIncrementalMigration(options(run, { ftsSql: FTS }))
		expect(synced).toBe(false)
		expect(files).toHaveLength(1)
		expect(files[0]).toMatch(/\/\d{14}_add_b\.sql$/)
		const sql = readFileSync(files[0] as string, "utf8")
		expect(sql).toMatch(/^CREATE VIRTUAL TABLE IF NOT EXISTS items_fts/)
		expect(sql).toMatch(/INSERT INTO items_fts\(items_fts\) VALUES \('rebuild'\);\n$/)
		expect(readFileSync(join(dir, "atlas.sum"), "utf8")).toBe(sumOf(dir))
	})

	it("appends the FTS delta after atlas's own SQL", () => {
		seed("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);")
		const run = fakeAtlas(({ dir: replayed }) => {
			writeFileSync(join(replayed, "20261017_add_b.sql"), "ALTER TABLE items ADD COLUMN flag INTEGER;\n")
			return ok()
		})
		const { files } = generateIncrementalMigration(options(run, { ftsSql: FTS }))
		expect(readFileSync(files[0] as string, "utf8")).toMatch(
			/^ALTER TABLE items ADD COLUMN flag INTEGER;\n\nCREATE VIRTUAL TABLE/,
		)
	})
})

describe("generateIncrementalMigration — postgres", () => {
	it("diffs the directory itself and reports what atlas added, or synced", () => {
		const added = fakeAtlas(({ dir: target }) => {
			writeFileSync(join(target, "20261017_add_b.sql"), "CREATE TABLE b (x int);\n")
			return ok()
		})
		expect(generateIncrementalMigration(options(added, { dialect: "postgres" }))).toEqual({
			files: [join(dir, "20261017_add_b.sql")],
			synced: false,
		})
		expect(added.calls[1]).toContain("postgres://localhost:5432/dev?sslmode=disable")
		expect(generateIncrementalMigration(options(fakeAtlas(), { dialect: "postgres", migrationName: "again" }))).toEqual(
			{
				files: [],
				synced: true,
			},
		)
	})
})

describe("generateIncrementalMigration: failures", () => {
	it("throws when the hash or the diff fails", () => {
		expect(() => generateIncrementalMigration(options(fakeAtlas(undefined, () => fail("hash broke"))))).toThrow(
			"atlas migrate hash failed: hash broke",
		)
		seed("CREATE TABLE a (x);")
		expect(() => generateIncrementalMigration(options(fakeAtlas(() => fail("diff broke"))))).toThrow(
			"atlas migrate diff failed: diff broke",
		)
		expect(() =>
			generateIncrementalMigration(options(fakeAtlas(() => ({ code: 1, stderr: "", stdout: " out " })))),
		).toThrow("atlas migrate diff failed: out")
	})

	it("refuses a history whose atlas.sum does not match its migrations", () => {
		seed("CREATE TABLE a (x);")
		writeFileSync(join(dir, "20260101000000_init.sql"), "CREATE TABLE a (edited);")
		expect(() => generateIncrementalMigration(options(fakeAtlas()))).toThrow(
			`${dir}/atlas.sum does not match its migrations; if a migration was edited on purpose, run atlas migrate hash`,
		)
	})
})
