/**
 * M77 of the 0.13.0 round, with the real Atlas: a schema other than public migrated under 0.12
 * kept its history in the shared atlas_schema_revisions. When its own history is missing or empty,
 * comb adopts the shared rows that match this directory's files as a prefix: apply and baseline
 * record them in the schema's own history, check and status say so and write nothing, and the
 * shared rows are never changed.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas, baselineWithAtlas, statusWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "../support/pg.ts"

/* baseline replays the history with Postgres's parser, which its caller loads */
beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-adopt-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const USERS = 'CREATE TABLE "users" ("id" integer PRIMARY KEY);\nINSERT INTO "users" VALUES (1), (2);\n'
const BACKFILL = 'INSERT INTO "users" VALUES (3);\n'

/** The migrations directory holding `files`, hashed */
function migrations(files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	hashDir(run, dir)
}

/** What comb 0.12 did: Atlas applies the directory to `schema`, its history in the shared atlas_schema_revisions */
function applyAs012(url: string, schema: string, from = dir): void {
	const target = `${url}${url.includes("?") ? "&" : "?"}search_path=${schema}`
	const args = [
		"migrate",
		"apply",
		"--url",
		target,
		"--dir",
		`file://${from}`,
		"--revisions-schema",
		"atlas_schema_revisions",
	]
	const ran = spawnSync("atlas", args, { encoding: "utf8" })
	if (ran.status !== 0) throw new Error(`atlas migrate apply: ${ran.stderr}${ran.stdout}`)
}

/** comb's approval, never asking: the files here are safe */
const approve = (m: ParsedMigration) => approveMigration(m, { target: "core", yes: false })

/** The options applyWithAtlas takes for schema app of the database at `url`, collecting what it prints */
function command(url: string, devUrl = "postgres://comb-no-dev.invalid/dev") {
	const out: string[] = []
	const target = { devUrl, lockTimeout: "5s", schema: "app", url }
	return { approve, dir, out, print: (line: string) => out.push(line), target }
}

async function query<T>(url: string, sql: string): Promise<T[]> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		return (await client.query(sql)).rows as T[]
	} finally {
		await client.end()
	}
}

const shared = (url: string) =>
	query(url, "SELECT version, hash FROM atlas_schema_revisions.atlas_schema_revisions ORDER BY version")
const own = async (url: string) =>
	(
		await query<{ t: string | null }>(
			url,
			"SELECT to_regclass('atlas_schema_revisions_app.atlas_schema_revisions') AS t",
		)
	)[0]?.t === null
		? undefined
		: (
				await query<{ version: string }>(
					url,
					"SELECT version FROM atlas_schema_revisions_app.atlas_schema_revisions ORDER BY version",
				)
			).map((r) => r.version)

/** A database whose schema app 0.12 migrated with `ran` (the users file), the backfill added since */
async function migratedUnder012(
	url: string,
	ran: Record<string, string> = { "20260101000000_users.sql": USERS },
): Promise<unknown[]> {
	await query(url, "CREATE SCHEMA app")
	migrations(ran)
	applyAs012(url, "app")
	migrations({ "20260102000000_backfill.sql": BACKFILL })
	return shared(url)
}

const ADOPTS =
	"1 file ran under 0.12's shared history; apply would adopt them, pending proof that the schema holds what they leave"
const PENDING_PROOF = ADOPTS

/** A dev database and a target, each a scratch database of its own: adoption replays what 0.12 ran on the dev database */
const withDevAndTarget = (body: (dev: string, url: string) => Promise<void>) =>
	withScratchDb((dev) => withScratchDb((url) => body(dev, url)))

describe("migrate on Postgres: a schema migrated under 0.12's shared history (M77)", () => {
	describe("with Atlas v1.3.0", () => {
		it("names what 0.12 ran in status and check, lists and classifies only the rest, and writes nothing", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const before = await migratedUnder012(url)
				const status = command(url, devUrl)
				expect(statusWithAtlas(status).pending).toEqual(["20260102000000_backfill.sql"])
				expect(status.out).toContain(ADOPTS)
				const check = command(url, devUrl)
				expect(await applyWithAtlas({ ...check, checkOnly: true })).toEqual(["20260102000000_backfill.sql"])
				expect(check.out).toContain(ADOPTS)
				expect(await own(url)).toBeUndefined()
				expect(await shared(url)).toEqual(before)
			})
		}, 60_000)

		it("adopts on apply, then applies the rest; a second apply finds its own history and adopts nothing", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const before = await migratedUnder012(url)
				const apply = command(url, devUrl)
				expect(await applyWithAtlas(apply)).toEqual(["20260102000000_backfill.sql"])
				expect(apply.out[0]).toBe("Adopted from 0.12's shared history: 20260101000000_users.sql")
				expect(await query(url, 'SELECT id FROM app."users" ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
				expect(await own(url)).toEqual(["20260101000000", "20260102000000"])
				const again = command(url, devUrl)
				expect(await applyWithAtlas(again)).toEqual([])
				expect(again.out).toEqual(["No migrations to apply"])
				expect(await shared(url)).toEqual(before)
			})
		}, 60_000)
	})
})

describe("migrate on Postgres: adopting 0.12's shared history in baseline, and after a failed copy (M77)", () => {
	describe("with Atlas v1.3.0", () => {
		it("adopts on baseline only what 0.12 ran, so the backfill still runs on apply", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const before = await migratedUnder012(url)
				const baseline = command(url, devUrl)
				expect(await baselineWithAtlas(baseline)).toEqual(["20260101000000_users.sql"])
				expect(await own(url)).toEqual(["20260101000000"])
				expect(await applyWithAtlas(command(url, devUrl))).toEqual(["20260102000000_backfill.sql"])
				expect(await query(url, 'SELECT id FROM app."users" ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
				expect(await shared(url)).toEqual(before)
			})
		}, 60_000)

		it("adopts after an apply that failed mid-copy, whose own history it left empty", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				await migratedUnder012(url, {
					"20260101000000_users.sql": USERS,
					"20260101000001_more.sql": 'CREATE TABLE "more" ("id" integer);\n',
				})
				/* a fault after the first row: the copy rolls back, the table Atlas made before it stays empty */
				await query(
					url,
					`CREATE FUNCTION public.refuse_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT count(*) FROM atlas_schema_revisions_app.atlas_schema_revisions) >= 1 THEN RAISE EXCEPTION 'injected fault'; END IF; RETURN NEW; END $$;
CREATE FUNCTION public.arm() RETURNS event_trigger LANGUAGE plpgsql AS $$ DECLARE r record; BEGIN FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() WHERE command_tag = 'CREATE TABLE' AND object_identity = 'atlas_schema_revisions_app.atlas_schema_revisions' LOOP EXECUTE 'CREATE TRIGGER fault BEFORE INSERT ON atlas_schema_revisions_app.atlas_schema_revisions FOR EACH ROW EXECUTE FUNCTION public.refuse_second()'; END LOOP; END $$;
CREATE EVENT TRIGGER arm ON ddl_command_end EXECUTE FUNCTION public.arm();`,
				)
				await expect(applyWithAtlas(command(url, devUrl))).rejects.toThrow("injected fault")
				expect(await own(url)).toEqual([])
				await query(
					url,
					"DROP EVENT TRIGGER arm; DROP TRIGGER fault ON atlas_schema_revisions_app.atlas_schema_revisions",
				)
				expect(await applyWithAtlas(command(url, devUrl))).toEqual(["20260102000000_backfill.sql"])
				expect(await own(url)).toEqual(["20260101000000", "20260101000001", "20260102000000"])
			})
		}, 60_000)
	})
})

describe("migrate on Postgres: what adopting 0.12's shared history refuses and keeps (M77, M78)", () => {
	describe("with Atlas v1.3.0", () => {
		it("refuses a file 0.12 ran that changed since, and one 0.12 skipped before a file it ran, naming it", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const before = await migratedUnder012(url)
				migrations({ "20260101000000_users.sql": USERS.replace("(1), (2)", "(1)") })
				const changed =
					"20260101000000_users.sql is not the file 0.12 ran: its hash is not the one the shared history recorded; restore it, and apply adopts it"
				expect(() => statusWithAtlas(command(url, devUrl))).toThrow(changed)
				await expect(applyWithAtlas(command(url, devUrl))).rejects.toThrow(changed)
				migrations({ "20260101000000_users.sql": USERS, "20251231000000_first.sql": "SELECT 1;\n" })
				const skipped =
					"0.12's shared history records 20260101000000_users.sql but not 20251231000000_first.sql, which comes before it, so comb cannot tell what ran; record it by hand"
				await expect(applyWithAtlas({ ...command(url, devUrl), checkOnly: true })).rejects.toThrow(skipped)
				expect(await own(url)).toBeUndefined()
				expect(await shared(url)).toEqual(before)
			})
		}, 60_000)

		it("refuses a file 0.12 ran halfway, outside a transaction", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				await query(url, "CREATE SCHEMA app")
				migrations({
					"20260101000000_half.sql":
						'-- atlas:txmode none\n\nCREATE TABLE "h" ("id" integer);\nINSERT INTO "nope" VALUES (1);\n',
				})
				expect(() => applyAs012(url, "app")).toThrow()
				const before = await shared(url)
				const half = "20260101000000_half.sql ran halfway under 0.12; finish or revert it by hand"
				expect(() => statusWithAtlas(command(url, devUrl))).toThrow(half)
				await expect(applyWithAtlas(command(url, devUrl))).rejects.toThrow(half)
				expect(await shared(url)).toEqual(before)
			})
		}, 60_000)

		it("adopts beside public's shared rows, which name no file here and stay", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const mine = dir
				dir = mkdtempSync(join(tmpdir(), "comb-pg-adopt-public-"))
				try {
					migrations({ "20260101000000_p.sql": 'CREATE TABLE "p" ("id" integer);\n' })
					applyAs012(url, "public")
				} finally {
					rmSync(dir, { force: true, recursive: true })
					dir = mine
				}
				await query(url, "CREATE SCHEMA app")
				migrations({ "20260105000000_users.sql": USERS })
				applyAs012(url, "app")
				const before = await shared(url)
				migrations({ "20260106000000_backfill.sql": BACKFILL })
				expect(await applyWithAtlas(command(url, devUrl))).toEqual(["20260106000000_backfill.sql"])
				expect(await own(url)).toEqual(["20260105000000", "20260106000000"])
				expect(await shared(url)).toEqual(before)
			})
		}, 60_000)
	})
})

/* P2 of the 0.14.1 review: public's rows share 0.12's table, so a new schema beside it matches them by version and hash alone */
describe("migrate on Postgres: an empty schema sharing public's directory and its shared history (P2)", () => {
	describe("with Atlas v1.3.0", () => {
		it("refuses to adopt in apply and baseline, recording nothing, and check and status say it awaits proof", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				migrations({ "20260101000000_users.sql": USERS })
				applyAs012(url, "public")
				await query(url, "CREATE SCHEMA app")
				const refusal =
					"app does not hold what 0.12's shared history ran (20260101000000_users.sql), so comb adopts none of it"
				await expect(applyWithAtlas(command(url, devUrl))).rejects.toThrow(refusal)
				await expect(baselineWithAtlas(command(url, devUrl))).rejects.toThrow(refusal)
				expect((await own(url)) ?? []).toEqual([])
				expect(await query(url, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'app'")).toEqual(
					[],
				)
				const status = command(url, devUrl)
				statusWithAtlas(status)
				expect(status.out).toContain(PENDING_PROOF)
				const check = command(url, devUrl)
				await applyWithAtlas({ ...check, checkOnly: true })
				expect(check.out).toContain(PENDING_PROOF)
			})
		}, 90_000)

		it("refuses to adopt, naming devUrl, when the dev database cannot be reached, recording nothing", async () => {
			await withScratchDb(async (url) => {
				await migratedUnder012(url)
				await expect(applyWithAtlas(command(url))).rejects.toThrow(
					"adopting 0.12's shared history needs devUrl, an empty Postgres database Atlas can reach, to prove app holds what it ran (20260101000000_users.sql)",
				)
				expect((await own(url)) ?? []).toEqual([])
			})
		}, 60_000)
	})
})
