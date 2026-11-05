/**
 * PR3 of r22b: the replay runs each history file on the session Atlas's apply runs it on. Atlas's
 * driver sends `search_path=<schema>` and `DateStyle=ISO, MDY` at connect, so RESET and DISCARD ALL
 * return to the target's schema, and a seeded date reads month first whatever devUrl's server
 * defaults to. The replay opens its sessions with the same startup settings, and apply is the oracle
 * of each case. Sibling: session-per-file.test.ts, a session per file (AE14).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas, baselineWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "../support/pg.ts"
import { asRole, query, testRoles } from "../support/pg-roles.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-replay-session-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** The files, named in order and hashed */
async function write(files: readonly string[]): Promise<void> {
	files.forEach((sql, i) => writeFileSync(join(dir, `2026010${i + 1}000000_f${i}.sql`), sql))
	await hashDir(run, dir)
}

/** A run's target: the scratch databases, `schema` searched */
const targetOf = (devUrl: string, url: string, schema: string) => ({ devUrl, lockTimeout: "5s", schema, url })

/** `act`'s outcome: "ok", or the message it threw */
async function said(act: () => Promise<unknown>): Promise<string> {
	try {
		await act()
		return "ok"
	} catch (error) {
		return (error as Error).message
	}
}

/** Check's and then apply's outcome for the files written, on one target whose `schema` exists */
async function checkThenApply(devUrl: string, url: string, schema: string): Promise<{ apply: string; check: string }> {
	const options = (checkOnly: boolean) => ({
		approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
		checkOnly,
		dir,
		print: () => undefined,
		target: targetOf(devUrl, url, schema),
	})
	const check = await said(() => applyWithAtlas(options(true)))
	return { apply: await said(() => applyWithAtlas(options(false))), check }
}

/** The files written, checked and applied on a fresh target holding `schema` */
const outcomes = (schema: string, devUrl?: string): Promise<{ apply: string; check: string }> =>
	withScratchDb((dev) =>
		withScratchDb(async (url) => {
			if (schema !== "public") await query(url, `CREATE SCHEMA ${schema}`)
			return checkThenApply(devUrl ?? dev, url, schema)
		}),
	)

const BOTH_OK = { apply: "ok", check: "ok" }

/* the settings a session runs a file on that its client or a SET gave it, those comb's replay adds for itself left out */
const PROBE = `-- comb:allow-unsafe: the test reads the session\nDO $$ BEGIN RAISE EXCEPTION 'session<%>', (SELECT string_agg(name || '=' || setting, '; ' ORDER BY name) FROM pg_settings WHERE source IN ('client', 'session') AND name NOT IN ('application_name', 'client_connection_check_interval', 'client_encoding', 'idle_in_transaction_session_timeout', 'lock_timeout', 'statement_timeout', 'transaction_isolation', 'transaction_read_only')); END $$;\n`

/** The session a probe's refusal names, past the statement it echoes */
const sessionOf = (message: string): string => /session<([^%>]*)>/.exec(message)?.[1] ?? message

describe("the replay's session is the one Atlas applies a file on (PR3 of r22b; sibling: AE14's session per file)", () => {
	it.each(["app", "public"])(
		"runs a file in schema %s with the startup settings apply's session has",
		async (schema) => {
			await write([PROBE])
			const { apply, check } = await outcomes(schema)
			expect(sessionOf(check)).toEqual(sessionOf(apply))
			expect(sessionOf(apply)).toContain(`search_path=${schema}`)
		},
		60_000,
	)

	it.each([
		[
			"RESET search_path",
			"-- comb:allow-unsafe: the test resets the path\nSET search_path TO public;\nCREATE TABLE helper (id int);\nRESET search_path;\n",
		],
		[
			"DISCARD ALL in a txmode none file",
			"-- atlas:txmode none\n\n-- comb:allow-unsafe: the test discards the session\nDISCARD ALL;\n",
		],
	])(
		"checks a file that runs %s and then alters a table in the target's schema as apply runs it",
		async (_, two) => {
			await write(["CREATE TABLE a (id int);\n", `${two}ALTER TABLE a ADD COLUMN x int;\n`])
			expect(await outcomes("app")).toEqual(BOTH_OK)
		},
		60_000,
	)

	it("baselines the database Atlas built from a file that makes a view after RESET search_path", async () => {
		await write([
			"CREATE TABLE a (id int);\n",
			"-- comb:allow-unsafe: the test resets the path\nSET search_path TO public;\nCREATE TABLE helper (id int);\nRESET search_path;\nCREATE VIEW v AS SELECT id FROM a;\n",
		])
		const outcome = await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				await query(url, "CREATE SCHEMA app")
				const target = targetOf(dev, url, "app")
				await applyWithAtlas({
					approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
					dir,
					print: () => undefined,
					target,
				})
				await query(url, "DROP SCHEMA atlas_schema_revisions_app CASCADE")
				return said(() => baselineWithAtlas({ dir, print: () => undefined, target }))
			}),
		)
		expect(outcome).toBe("ok")
	}, 60_000)
})

describe("the replay reads a date as Atlas's session does, whatever devUrl's server defaults to (PR3 of r22b)", () => {
	it.each([
		["13/01/2026", false],
		["01/13/2026", true],
	])(
		"checks a seeded date of %s month first, as apply reads it, on a devUrl whose DateStyle is DMY",
		async (value, applies) => {
			const [dmy] = testRoles("comb_t_dmy")
			await write([`CREATE TABLE d (at date);\nINSERT INTO d VALUES ('${value}');\n`])
			const { apply, check } = await withScratchDb(async (dev) => {
				const devUrl = await asRole(dev, dmy, "CREATEDB")
				await query(dev, `ALTER ROLE ${dmy} SET DateStyle = 'ISO, DMY'`)
				return withScratchDb((url) => checkThenApply(devUrl, url, "public"))
			})
			expect(apply === "ok").toBe(applies)
			expect(check === "ok").toBe(applies)
		},
		60_000,
	)
})
