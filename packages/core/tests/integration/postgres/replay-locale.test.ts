/**
 * PR4 of r22b: the replay's database takes the target database's encoding and locale, so a text
 * range partition, a CHECK on text order or bytes, or a seed checks as apply runs it on the target,
 * whatever the server's default (template0's) is. Apply is the oracle of each case; devUrl's own
 * database stays at the server's default, so only the target's locale can make them agree.
 * Sibling: replay-session.test.ts, the session a file runs on (PR3).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-replay-locale-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** The file, hashed */
async function write(sql: string): Promise<void> {
	writeFileSync(join(dir, "20260101000000_one.sql"), sql)
	await hashDir(run, dir)
}

/** `act`'s outcome: "ok", or the message it threw */
async function said(act: () => Promise<unknown>): Promise<string> {
	try {
		await act()
		return "ok"
	} catch (error) {
		return (error as Error).message
	}
}

/** Check's and then apply's outcome for the file written, on a target made with `options` and a devUrl at the server's default */
const outcomes = (options: string): Promise<{ apply: boolean; check: boolean }> =>
	withScratchDb((devUrl) =>
		withScratchDb(async (url) => {
			const target = { devUrl, lockTimeout: "5s", schema: "public", url }
			const applying = (checkOnly: boolean) =>
				said(() =>
					applyWithAtlas({
						approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
						checkOnly,
						dir,
						print: () => undefined,
						target,
					}),
				)
			const check = await applying(true)
			return { apply: (await applying(false)) === "ok", check: check === "ok" }
		}, options),
	)

/* a range partition whose bounds order 'a' before 'N' under en_US and after it by code point */
const RANGE =
	"CREATE TABLE names (n text) PARTITION BY RANGE (n);\nCREATE TABLE names_a_m PARTITION OF names FOR VALUES FROM ('a') TO ('N');\n"

describe("the replay's database has the target's locale and encoding, whatever the server's default (PR4 of r22b)", () => {
	it.each([
		["libc C", "TEMPLATE template0 LOCALE 'C'", RANGE],
		["libc en_US.utf8", "TEMPLATE template0 LOCALE 'en_US.utf8'", RANGE],
		["builtin C.UTF-8", "TEMPLATE template0 LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C'", RANGE],
		[
			"ICU en-US with a rule sorting a after N",
			"TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'en-US' ICU_RULES '&N < a' LOCALE 'C'",
			RANGE,
		],
		[
			"LATIN1, where é is one byte",
			"TEMPLATE template0 ENCODING 'LATIN1' LOCALE 'C'",
			"CREATE TABLE t (s text CHECK (octet_length(s) = 1));\nINSERT INTO t VALUES ('é');\n",
		],
	])(
		"checks a file on a target at %s as apply runs it there",
		async (_, options, sql) => {
			await write(sql)
			const { apply, check } = await outcomes(options)
			expect(check).toBe(apply)
		},
		60_000,
	)
})
