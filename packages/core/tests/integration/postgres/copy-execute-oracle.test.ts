/**
 * comb's ratings of COPY and EXECUTE held to the pinned Atlas on Postgres 17 (PA15 of r22b). Each case
 * applies a table t, then its files, with `atlas migrate apply`; comb reads the last file on the
 * history of the ones before it. A COPY comb refuses at check is one Atlas's driver cannot run; every
 * statement comb rates Atlas runs, but an EXECUTE of a statement its file never prepared: comb's
 * apply runs one Atlas call per file (atlas-apply-runs.ts), so an earlier file's PREPARE never reaches
 * it, and comb refuses it at check (AE2-9 of r22).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

const TABLE = "CREATE TABLE t (id int);\n"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-copy-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** Atlas's apply of `files` after the table: "applies", or "fails: " and the last line it printed */
const atlas = (files: readonly string[]): Promise<string> =>
	withScratchDb(async (url) => {
		for (const [i, file] of [TABLE, ...files].entries()) writeFileSync(join(dir, `${i + 1}_m.sql`), file)
		await hashDir(run, dir)
		const ran = await run("atlas", ["migrate", "apply", "--url", url, "--dir", `file://${dir}`])
		return ran.code === 0 ? "applies" : `fails: ${`${ran.stdout}${ran.stderr}`.trim().split("\n").at(-1) ?? ""}`
	})

/**
 * Atlas's apply of `files` after the table as comb's apply runs it, one call per file, each on a
 * session of its own (atlas-apply-runs.ts): "applies", or "fails: " and the last line it printed
 */
const atlasPerFile = (files: readonly string[]): Promise<string> =>
	withScratchDb(async (url) => {
		for (const [i, file] of [TABLE, ...files].entries()) writeFileSync(join(dir, `${i + 1}_m.sql`), file)
		await hashDir(run, dir)
		for (const _ of [TABLE, ...files]) {
			const ran = await run("atlas", ["migrate", "apply", "--url", url, "--dir", `file://${dir}`, "1"])
			if (ran.code !== 0) return `fails: ${`${ran.stdout}${ran.stderr}`.trim().split("\n").at(-1) ?? ""}`
		}
		return "applies"
	})

/** comb's rating of the last of `files` after the table and the ones before it: its safety, or "refused" */
function comb(files: readonly string[]): string {
	const before = extractSchema([TABLE, ...files.slice(0, -1)].join(""), undefined, "postgres")
	try {
		return classifyMigration(files.at(-1) as string, { before, dialect: "postgres" }).safety
	} catch {
		return "refused"
	}
}

const CANNOT_RUN = "fails: sql/migrate: write revision: driver: bad connection"

const CASES: ReadonlyArray<[what: string, files: readonly string[], atlas: string, comb: string]> = [
	["a COPY FROM STDIN", ["COPY t FROM STDIN;\n"], CANNOT_RUN, "refused"],
	["a COPY FROM STDIN with its rows", ["COPY t FROM STDIN;\n1\n\\.\n"], CANNOT_RUN, "refused"],
	["a COPY TO STDOUT", ["COPY t TO STDOUT;\n"], CANNOT_RUN, "refused"],
	["a COPY of a query TO STDOUT", ["COPY (SELECT 1) TO STDOUT;\n"], CANNOT_RUN, "refused"],
	["a COPY FROM a server file", ["COPY t FROM '/dev/null';\n"], "applies", "cautious"],
	["a COPY FROM a server program", ["COPY t FROM PROGRAM 'true';\n"], "applies", "unsafe"],
	["a COPY TO a server file", ["COPY t TO '/dev/null';\n"], "applies", "unsafe"],
	[
		"an EXECUTE of the file's own PREPARE",
		["PREPARE p AS INSERT INTO t VALUES (1);\nEXECUTE p;\n"],
		"applies",
		"cautious",
	],
	[
		"an EXECUTE of the file's own PREPARE of a DELETE",
		["PREPARE p AS DELETE FROM t;\nEXECUTE p;\n"],
		"applies",
		"unsafe",
	],
]

describe("a COPY or an EXECUTE, as the pinned Atlas runs it on Postgres 17 (PA15 of r22b)", () => {
	it.each(CASES.map(([what, files, applied, rated]) => ({ applied, files, rated, what })))(
		"$what",
		async ({ applied, files, rated, what }) => {
			expect({ atlas: await atlas(files), comb: comb(files), what }).toEqual({ atlas: applied, comb: rated, what })
		},
		60_000,
	)

	it("has an EXECUTE of a statement prepared nowhere fail, which comb refuses", async () => {
		/* the EXECUTE aborts the file's transaction, and Atlas's revision write after it fails */
		expect(await atlas(["EXECUTE nothere(1);\n"])).toBe(
			"fails: sql/migrate: write revision: pq: current transaction is aborted, commands ignored until end of transaction block (25P02)",
		)
		expect(comb(["EXECUTE nothere(1);\n"])).toBe("refused")
	}, 60_000)

	/* AE2-9 of r22: one Atlas call ran both files on one session, where comb's apply runs each on its own */
	it("has an EXECUTE of an earlier file's PREPARE fail as comb applies it, which comb refuses", async () => {
		const files = ["PREPARE p AS DELETE FROM t;\n", "EXECUTE p;\n"]
		expect(await atlasPerFile(files)).toBe(
			"fails: sql/migrate: write revision: pq: current transaction is aborted, commands ignored until end of transaction block (25P02)",
		)
		expect(comb(files)).toBe("refused")
	}, 60_000)

	/* AE2-2 of r22: an EXECUTE under a CREATE TABLE AS runs the prepared statement's writes as a bare one does */
	it("has a CREATE TABLE AS EXECUTE delete the rows its PREPARE names, which comb rates unsafe", async () => {
		const file = "PREPARE p AS WITH d AS (DELETE FROM t RETURNING id) SELECT id FROM d;\nCREATE TABLE x AS EXECUTE p;\n"
		const left = await withScratchDb(async (url) => {
			for (const [i, each] of [`${TABLE}INSERT INTO t VALUES (1), (2);\n`, file].entries())
				writeFileSync(join(dir, `${i + 1}_m.sql`), each)
			await hashDir(run, dir)
			const ran = await run("atlas", ["migrate", "apply", "--url", url, "--dir", `file://${dir}`])
			const client = new pg.Client({ connectionString: url })
			await client.connect()
			try {
				const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM t")
				return { code: ran.code, rows: rows[0]?.n }
			} finally {
				await client.end()
			}
		})
		expect(left).toEqual({ code: 0, rows: 0 })
		expect(comb([file])).toBe("unsafe")
	}, 60_000)
})

describe("an EXECUTE that user code before it may prepare, as comb applies it on Postgres 17 (AE2-9 of r22)", () => {
	/*
	 * AE2-9 of r22, as ruled: a refusal is as sound as a rating, so comb refuses no file Postgres runs.
	 * A trigger an INSERT fires, or an event trigger a DDL statement fires, may PREPARE the name an
	 * EXECUTE after it runs; under a CREATE TABLE AS, ddl_command_start fires before its EXECUTE's lookup
	 */
	it.each([
		[
			"a trigger an INSERT fires",
			`CREATE FUNCTION tp() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN EXECUTE 'PREPARE p AS DELETE FROM t'; RETURN NULL; END$$;\nCREATE TRIGGER tp BEFORE INSERT ON t FOR EACH STATEMENT EXECUTE FUNCTION tp();\n`,
			"INSERT INTO t VALUES (1);\nEXECUTE p;\n",
		],
		[
			"an event trigger a CREATE TABLE fires",
			`CREATE FUNCTION ep() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN EXECUTE 'PREPARE p AS DELETE FROM t'; END$$;\nCREATE EVENT TRIGGER ep ON ddl_command_start WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION ep();\n`,
			"CREATE TABLE y (id int);\nEXECUTE p;\n",
		],
		[
			"an event trigger the CREATE TABLE AS around it fires",
			`CREATE FUNCTION ep() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN EXECUTE 'PREPARE p AS SELECT 1 AS id'; END$$;\nCREATE EVENT TRIGGER ep ON ddl_command_start WHEN TAG IN ('CREATE TABLE AS') EXECUTE FUNCTION ep();\n`,
			"CREATE TABLE x AS EXECUTE p;\n",
		],
	])(
		"has an EXECUTE that %s may prepare apply as comb applies it, which comb rates unsafe",
		async (_, history, file) => {
			expect(await atlasPerFile([history, file])).toBe("applies")
			expect(comb([history, file])).toBe("unsafe")
		},
		60_000,
	)
})
