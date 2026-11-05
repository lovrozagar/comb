/**
 * SL5 of r22 on D1 through the real wrangler --local (sibling: libsql/hash-space.test.ts): a hash this comb
 * records in `_comb_migration_hashes` carries `hash_v`, so a file applied with a plain space and edited to
 * U+00A0, which SQLite reads as part of a name, is edited. A hash comb 0.20.1 recorded, every space folded
 * and no `hash_v`, still vouches for its file so edited; check reads that history and writes nothing; and
 * wrangler, which reads only its own table, still applies a file of its own over a history comb marked.
 * Baseline copies the hash comb's history before 0.8 holds, which vouches for no edit since.
 */
import fs from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../../src/cli/index.ts"
import { foldedMigrationHash, generateMigrationHash } from "../../../src/migrate/core/parse.ts"
import { d1Column, d1Io, d1Project, wrangler, writeMigrations } from "../support/d1-project.ts"

const ASCII = "CREATE TABLE t (id INTEGER PRIMARY KEY, a b);"
const UNICODE = "CREATE TABLE t (id INTEGER PRIMARY KEY, a b);"
const FILE = "20260101000000_t.sql"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

function project(migrations: Record<string, string>): string {
	const dir = d1Project(migrations)
	dirs.push(dir)
	return dir
}

const comb = async (dir: string, command: string) => {
	const io = d1Io(dir)
	return { code: await runCli(["migrate", command, "core", "--local"], io), errors: io.errors.join("\n") }
}

/** wrangler's own apply of the pending files, as a project runs it without comb */
const wranglerApply = (dir: string) =>
	wrangler(dir)("wrangler", ["d1", "migrations", "apply", "core", "--local"], { input: "" })

/** `sql` on the project's local D1 */
const execute = (dir: string, sql: string) =>
	wrangler(dir)("wrangler", ["d1", "execute", "core", "--local", `--command=${sql}`])

describe("comb migrate on D1, --local, on a file holding a space SQLite reads as part of a name", () => {
	it.each([
		["a plain space, then edited to U+00A0", ASCII, UNICODE],
		["U+00A0, then edited to a plain space", UNICODE, ASCII],
	])(
		"refuses a file this comb applied with %s",
		async (_, applied, edited) => {
			const dir = project({ [FILE]: applied })
			expect(await comb(dir, "apply")).toEqual({ code: 0, errors: "" })
			writeMigrations(dir, { [FILE]: edited })
			for (const command of ["status", "check"]) {
				const run = await comb(dir, command)
				expect(run.code).toBe(1)
				expect(run.errors).toContain(`${FILE} was applied, then edited`)
			}
		},
		120_000,
	)

	it("accepts the file edited to U+00A0 on comb 0.20.1's record, writes nothing at check, and marks only what it records", async () => {
		const dir = project({ [FILE]: ASCII })
		/* what comb 0.20.1 left: wrangler's row, and the folded hash in comb's table as 0.20.1 made it */
		expect((await wranglerApply(dir)).code).toBe(0)
		const hash = foldedMigrationHash(ASCII)
		const setup = `CREATE TABLE _comb_migration_hashes (name TEXT PRIMARY KEY, hash TEXT NOT NULL); INSERT OR REPLACE INTO _comb_migration_hashes (name, hash) VALUES ('${FILE}', '${hash}')`
		expect((await execute(dir, setup)).code).toBe(0)
		writeMigrations(dir, { [FILE]: UNICODE })
		const columns = "SELECT group_concat(name) FROM pragma_table_info('_comb_migration_hashes')"
		for (const command of ["status", "check"]) expect(await comb(dir, command)).toEqual({ code: 0, errors: "" })
		expect(await d1Column(dir, columns)).toEqual(["name,hash"])
		writeMigrations(dir, { "20260102000000_u.sql": "CREATE TABLE u (id INTEGER PRIMARY KEY);" })
		expect(await comb(dir, "apply")).toEqual({ code: 0, errors: "" })
		const marks = "SELECT name || ':' || coalesce(hash_v, 'null') FROM _comb_migration_hashes ORDER BY name"
		expect(await d1Column(dir, marks)).toEqual([`${FILE}:null`, "20260102000000_u.sql:2"])
		expect(await comb(dir, "check")).toEqual({ code: 0, errors: "" })
		/* wrangler applies a file of its own over the marked history, and comb reads it as applied without a hash */
		writeMigrations(dir, { "20260103000000_v.sql": "CREATE TABLE v (id INTEGER PRIMARY KEY);" })
		expect((await wranglerApply(dir)).code).toBe(0)
		expect(await d1Column(dir, "SELECT name FROM d1_migrations ORDER BY id")).toEqual([
			FILE,
			"20260102000000_u.sql",
			"20260103000000_v.sql",
		])
		const io = d1Io(dir)
		expect(await runCli(["migrate", "status", "core", "--local"], io)).toBe(0)
		expect(io.outputs).toContain(
			"No hash recorded for 20260103000000_v.sql, applied before comb recorded them: comb cannot tell whether it was edited since",
		)
	}, 180_000)
})

describe("comb migrate baseline on D1, --local, over comb's history before 0.8", () => {
	it("copies the hash that history holds, marked only when it is the file's exact one", async () => {
		const plain = "CREATE TABLE p (id INTEGER PRIMARY KEY);"
		const dir = project({ [FILE]: UNICODE, "20260102000000_p.sql": plain })
		/* comb 0.7 recorded the folded hash, which the file's text still has, and the exact hash of the other */
		const hashes = [foldedMigrationHash(UNICODE), generateMigrationHash(plain)].map((hash) => `('${hash}', 1)`)
		const setup = `CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER); INSERT INTO __drizzle_migrations (hash, created_at) VALUES ${hashes.join(", ")}; ${UNICODE} ${plain}`
		expect((await execute(dir, setup)).code).toBe(0)
		expect((await comb(dir, "baseline")).code).toBe(0)
		const copied =
			"SELECT name || ':' || hash || ':' || coalesce(hash_v, 'null') FROM _comb_migration_hashes ORDER BY name"
		expect(await d1Column(dir, copied)).toEqual([
			`${FILE}:${foldedMigrationHash(UNICODE)}:null`,
			`20260102000000_p.sql:${generateMigrationHash(plain)}:2`,
		])
		expect(await comb(dir, "check")).toEqual({ code: 0, errors: "" })
	}, 180_000)
})
