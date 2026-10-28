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

type FakeAtlas = Run & { calls: string[][]; envs: Array<Readonly<Record<string, string | undefined>> | undefined> }

/**
 * A model of the atlas CLI: `migrate hash` writes the dir's atlas.sum, `migrate diff` hands the
 * replayed directory, the migration name and the target schema to `onDiff`, which may write the
 * new migration into the directory and returns what atlas would.
 */
function fakeAtlas(onDiff: (call: DiffCall) => RunResult = () => ok(), hashResult?: () => RunResult): FakeAtlas {
	const calls: string[][] = []
	const envs: FakeAtlas["envs"] = []
	const fake: Run = (_cmd, args, runOptions) => {
		calls.push([...args])
		envs.push(runOptions?.env)
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
	return Object.assign(fake, { calls, envs })
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
		expect(result).toEqual({ files: [join(dir, "20261017_add_b.sql")], notices: [], synced: false })
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
		expect(generateIncrementalMigration(options(run))).toEqual({ files: [], notices: [], synced: true })
		/* the integrity check and the replayed copy are hashed; the directory itself is not */
		expect(run.calls.filter((call) => call[1] === "hash")).toHaveLength(2)
	})

	it("reports synced when atlas exits 0 and writes nothing", () => {
		seed("CREATE TABLE a (x);")
		expect(generateIncrementalMigration(options(fakeAtlas()))).toEqual({ files: [], notices: [], synced: true })
	})

	it("creates the migrations directory when it is missing", () => {
		const missing = join(dir, "nested", "migrations")
		expect(generateIncrementalMigration(options(fakeAtlas(), { migrationsDir: missing }))).toEqual({
			files: [],
			notices: [],
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

describe("generateIncrementalMigration — the names of what atlas adds", () => {
	it("numbers what atlas adds after the history, when atlas stamps it in the same second or behind (two diffs in one second, a clock behind a teammate's)", () => {
		seed("CREATE TABLE a (x);")
		writeFileSync(join(dir, "20261021073441_step.sql"), "CREATE TABLE s (x);\n")
		writeFileSync(join(dir, "atlas.sum"), sumOf(dir))
		const run = fakeAtlas(({ dir: replayed }) => {
			writeFileSync(join(replayed, "20261021073441_body.sql"), "ALTER TABLE s ADD COLUMN y;\n")
			writeFileSync(join(replayed, "20261021073400_more.sql"), "CREATE TABLE m (x);\n")
			return ok()
		})
		const { files } = generateIncrementalMigration(options(run))
		expect(files).toEqual([join(dir, "20261021073442_more.sql"), join(dir, "20261021073443_body.sql")])
		expect(readFileSync(join(dir, "20261021073443_body.sql"), "utf8")).toBe("ALTER TABLE s ADD COLUMN y;\n")
		expect(existsSync(join(dir, "20261021073441_body.sql"))).toBe(false)
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
		expect(result).toEqual({ files: [], notices: [], synced: true })
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
		expect(sql).toMatch(/INSERT INTO "items_fts"\("items_fts"\) VALUES \('rebuild'\);\n$/)
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

/** A Postgres target whose dev database has a password to keep out of argv and errors */
const target = {
	/* a password no temporary path can hold by chance */
	devUrl: "postgres://dev:Dev-Secret-0451@localhost/dev?sslmode=disable",
	lockTimeout: "5s",
	schema: "public",
	url: "",
}

describe("generateIncrementalMigration — postgres", () => {
	it("diffs through Atlas with the dev database in its environment, scoped to the schema, never in argv", () => {
		const added = fakeAtlas(({ dir: replayed }) => {
			writeFileSync(join(replayed, "20261017_add_b.sql"), "CREATE TABLE b (x int);\n")
			return ok()
		})
		expect(generateIncrementalMigration(options(added, { dialect: "postgres", target }))).toEqual({
			files: [join(dir, "20261017_add_b.sql")],
			notices: [],
			synced: false,
		})
		const diff = added.calls.findIndex((call) => call[1] === "diff")
		expect(added.calls[diff]?.join(" ")).not.toContain("Dev-Secret-0451")
		expect(added.calls[diff]?.join(" ")).not.toContain("postgres://")
		expect(added.calls[diff]).toContain("--config")
		expect(added.envs[diff]?.["COMB_ATLAS_DEV_URL"]).toBe(
			"postgres://dev:Dev-Secret-0451@localhost/dev?sslmode=disable&search_path=public",
		)
		expect(
			generateIncrementalMigration(options(fakeAtlas(), { dialect: "postgres", migrationName: "again", target })),
		).toEqual({
			files: [],
			notices: [],
			synced: true,
		})
	})
})

describe("generateIncrementalMigration — postgres objects Atlas refuses", () => {
	it("replays the history without the objects Atlas refuses, keeping its directives, and wraps Atlas's file", () => {
		seed(
			'-- atlas:txmode none\nCREATE TABLE "post" ("title" text);\nCREATE VIEW "v" AS (select "title" from "post");\nCREATE INDEX CONCURRENTLY "i" ON "post" ("title");\n',
		)
		const seen: DiffCall[] = []
		const atlas = fakeAtlas((call) => {
			seen.push(call)
			writeFileSync(
				join(call.dir, "20261018000000_retype.sql"),
				'ALTER TABLE "post" ALTER COLUMN "title" TYPE varchar(50);\n',
			)
			return ok()
		})
		const schema = 'CREATE TABLE "post" ("title" varchar(50));\nCREATE VIEW "v" AS (select "title" from "post");\n'
		const { files } = generateIncrementalMigration(
			options(atlas, { dialect: "postgres", target, targetSchema: schema }),
		)
		expect(seen[0]?.history["20260101000000_init.sql"]).toBe(
			'-- atlas:txmode none\nCREATE TABLE "post" ("title" text);\nCREATE INDEX CONCURRENTLY "i" ON "post" ("title");\n',
		)
		expect(seen[0]?.target).toBe('CREATE TABLE "post" ("title" varchar(50));\n')
		expect(readFileSync(files[0] as string, "utf8")).toBe(
			'DROP VIEW IF EXISTS "v";\n\nALTER TABLE "post" ALTER COLUMN "title" TYPE varchar(50);\n\nCREATE VIEW "v" AS (select "title" from "post");\n',
		)
		expect(readFileSync(join(dir, "atlas.sum"), "utf8")).toBe(sumOf(dir))
	})

	it("writes comb's part alone when only a comb-owned object changed", () => {
		seed('CREATE TABLE "post" ("title" text);\nCREATE VIEW "v" AS (select 1);\n')
		const schema = 'CREATE TABLE "post" ("title" text);\nCREATE VIEW "v" AS (select 2);\n'
		const { files, synced } = generateIncrementalMigration(
			options(fakeAtlas(), { dialect: "postgres", target, targetSchema: schema }),
		)
		expect(synced).toBe(false)
		expect(files[0]).toMatch(/\d{14}_add_b\.sql$/)
		expect(readFileSync(files[0] as string, "utf8")).toBe(
			'DROP VIEW IF EXISTS "v";\n\nCREATE VIEW "v" AS (select 2);\n',
		)
	})
})

describe("generateIncrementalMigration — postgres enums and failures", () => {
	it("writes the enum values Atlas adds into a file of their own before the one that uses them", () => {
		seed("CREATE TYPE \"status\" AS ENUM ('draft');\n")
		const atlas = fakeAtlas((call) => {
			writeFileSync(
				join(call.dir, "20261018000000_archive.sql"),
				'ALTER TYPE "status" ADD VALUE \'archived\';\nALTER TABLE "post" ADD COLUMN "s" "status" DEFAULT \'archived\';\n',
			)
			return ok()
		})
		const { files } = generateIncrementalMigration(options(atlas, { dialect: "postgres", target, targetSchema: "T" }))
		expect(files).toEqual([
			join(dir, "20261018000000_archive_enum_values.sql"),
			join(dir, "20261018000001_archive.sql"),
		])
		expect(readFileSync(files[0] as string, "utf8")).toBe("ALTER TYPE \"status\" ADD VALUE 'archived';\n")
		expect(readdirSync(dir).sort()).toEqual([
			"20260101000000_init.sql",
			"20261018000000_archive_enum_values.sql",
			"20261018000001_archive.sql",
			"atlas.sum",
		])
	})

	it("copies every further file Atlas adds", () => {
		const atlas = fakeAtlas((call) => {
			writeFileSync(join(call.dir, "20261018000000_a.sql"), 'CREATE TABLE "a" ("x" int);\n')
			writeFileSync(join(call.dir, "20261018000001_b.sql"), 'CREATE TABLE "b" ("x" int);\n')
			return ok()
		})
		const { files } = generateIncrementalMigration(options(atlas, { dialect: "postgres", target }))
		expect(files).toEqual([join(dir, "20261018000000_a.sql"), join(dir, "20261018000001_b.sql")])
		expect(readFileSync(files[1] as string, "utf8")).toBe('CREATE TABLE "b" ("x" int);\n')
	})
})

describe("generateIncrementalMigration — postgres refusals", () => {
	it("explains Atlas's refusal to drop an enum value", () => {
		const refusing = fakeAtlas(() => fail('Error: dropping value "b" from enum "mood" is not supported'))
		expect(() => generateIncrementalMigration(options(refusing, { dialect: "postgres", target }))).toThrow(
			'atlas migrate diff failed: Atlas cannot drop the value "b" of enum "mood"',
		)
	})

	it("names a file it writes itself after the directory's latest version, even one in the future", () => {
		writeFileSync(join(dir, "29991231235959_ahead.sql"), 'CREATE VIEW "v" AS (select 1);\n')
		writeFileSync(join(dir, "atlas.sum"), sumOf(dir))
		const schema = 'CREATE VIEW "v" AS (select 2);\n'
		const { files } = generateIncrementalMigration(
			options(fakeAtlas(), { dialect: "postgres", target, targetSchema: schema }),
		)
		expect(files).toEqual([join(dir, "30000101000000_add_b.sql")])
	})

	it("needs the database's target on postgres", () => {
		expect(() => generateIncrementalMigration(options(fakeAtlas(), { dialect: "postgres" }))).toThrow(
			"a Postgres diff needs the database's target (devUrl and schema)",
		)
	})

	it("scrubs the dev database's password from Atlas's failure", () => {
		const failing = fakeAtlas(() => fail("dial postgres://dev:pw@localhost/dev: refused"))
		expect(() => generateIncrementalMigration(options(failing, { dialect: "postgres", target }))).toThrow(
			"atlas migrate diff failed: dial postgres://dev:***@localhost/dev: refused",
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
