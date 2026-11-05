/**
 * comb's ATTACH warnings held to Postgres 17's own proof (PA16 of r22b). Each case runs its history
 * on a fresh database, then its ATTACH with client_min_messages at DEBUG1, where Postgres reports a
 * bound its constraints imply ("partition constraint for table ... is implied by existing
 * constraints") and skips the partition's scan. Every case comb warns of nothing for is one Postgres
 * skips; every case comb warns of is one Postgres scans, refuses, or proves by a rule comb does not
 * follow, which the last list names.
 */
import pg from "pg"
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { IMPLIED, SCANNED, TEMPS } from "../../support/attach-cases.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

/** What Postgres made of `attach` after `history`: "skips" the scan, "scans", or "refuses: " and why */
const postgres = (history: string, attach: string): Promise<string> =>
	withScratchDb(async (url) => {
		const client = new pg.Client({ connectionString: url })
		const notices: string[] = []
		client.on("notice", (notice) => notices.push(notice.message ?? ""))
		await client.connect()
		try {
			await client.query(history)
			await client.query("SET client_min_messages = debug1")
			const refused = await client.query(attach).then(
				() => undefined,
				(error: Error) => error.message,
			)
			if (refused !== undefined) return `refuses: ${refused}`
			return notices.some((notice) => notice.endsWith("is implied by existing constraints")) ? "skips" : "scans"
		} finally {
			await client.end()
		}
	})

/** comb's lock warnings on `attach` after `history` */
const warned = (history: string, attach: string): string[] =>
	classifyMigration(attach, { before: extractSchema(history, undefined, "postgres"), dialect: "postgres" }).lockWarnings

/**
 * The cases comb warns of that Postgres 17 still proves, each with the rule comb leaves to the scan:
 * a proof it does not follow, one that holds only under this session's settings, or one whose ATTACH
 * still scans or locks the partition for another reason. A case leaving or joining this list is a
 * change of comb's precision, which this test names.
 */
const PROVEN_BEYOND_COMB: ReadonlyMap<string, string> = new Map([
	["a CHECK NO INHERIT", "the partition's own constraint, inheritable or not"],
	["a CHECK with a term comb does not read", "an AND whose other terms comb does not parse"],
	["a CHECK tighter than the bound", "an implication past equal clauses"],
	["a CHECK whose constant is cast", "a constant folded from a cast"],
	["a >= a migration defined", "an operator Postgres resolves to the built-in one"],
	["the CHECK validated in the ALTER that drops another", "a proof comb forgets on any DROP CONSTRAINT"],
	["a CHECK with <>", "an implication past equal clauses"],
	["a CHECK of a schema-qualified operator", "an operator Postgres resolves to the built-in one"],
	["a list CHECK holding a call", "a call folded to a constant"],
	["a column renamed", "a proof comb forgets on a RENAME COLUMN"],
	["a parent with an index", "the index ATTACH builds on the partition, which scans it"],
	["a parent with a foreign key", "the foreign key ATTACH validates on the partition, which scans it"],
	["a parent made LIKE another", "a parent whose indexes and constraints comb does not read"],
	["a parent's key column renamed", "a key comb no longer names"],
	["a timestamptz key, whose constants read by the session's TimeZone", "a bound this session's TimeZone fixes"],
	["a date that reads by the session's DateStyle", "a bound this session's DateStyle fixes"],
	["an integer key bounded by a string", "a string Postgres coerces to the key's type"],
	["a list with NULL", "a NULL the key's NOT NULL excludes"],
	["another constraint dropped", "a proof comb forgets on any DROP CONSTRAINT"],
	[
		"a CHECK that also names another column",
		"a CHECK term on a column beside the key, which a CASCADE drop may take (AE2-1 of r22)",
	],
])

describe("an ATTACH comb warns of nothing for, on Postgres 17 (PA16 of r22b)", () => {
	it.each(IMPLIED)(
		"skips the scan for %s",
		async (_case, history, attach) => {
			expect({ postgres: await postgres(history, attach), warned: warned(history, attach) }).toEqual({
				postgres: "skips",
				warned: [],
			})
		},
		60_000,
	)
})

describe("an ATTACH comb warns of, on Postgres 17 (siblings of PA16 of r22b)", () => {
	it.each(SCANNED)(
		"scans, refuses, or proves by a rule comb leaves to the scan for %s",
		async (what, history, attach) => {
			const verdict = await postgres(history, attach)
			expect(warned(history, attach)).not.toEqual([])
			expect({ what, skips: verdict === "skips" }).toEqual({ what, skips: PROVEN_BEYOND_COMB.has(what) })
		},
		60_000,
	)
})

/**
 * Whether Postgres scans the partition for the ATTACH that ends `pending`, after `files`, each file on
 * a session of its own, as comb's apply runs it (AE2-5 of r22)
 */
const scansPerFile = (files: readonly string[], pending: string): Promise<boolean> =>
	withScratchDb(async (url) => {
		const notices: string[] = []
		for (const [i, file] of [...files, pending].entries()) {
			const client = new pg.Client({ connectionString: url })
			client.on("notice", (notice) => notices.push(notice.message ?? ""))
			await client.connect()
			try {
				if (i === files.length) await client.query("SET client_min_messages = debug1")
				await client.query(file)
			} finally {
				await client.end()
			}
		}
		return !notices.some((notice) => notice.endsWith("is implied by existing constraints"))
	})

describe("an ATTACH after a temp table of the partition's name, as comb applies it on Postgres 17 (AE2-5 of r22)", () => {
	it.each(TEMPS.map(([what, files, pending, scans]) => ({ files, pending, scans, what })))(
		"warns of the scan for $what only when Postgres scans",
		async ({ files, pending, scans }) => {
			const before = files.reduce(
				(schema, file) => extractSchema(file, schema, "postgres"),
				extractSchema("", undefined, "postgres"),
			)
			const scanWarned = classifyMigration(pending, { before, dialect: "postgres" }).lockWarnings.some((warning) =>
				warning.includes("under an exclusive lock to check its bound"),
			)
			expect({ postgres: await scansPerFile(files, pending), warned: scanWarned }).toEqual({
				postgres: scans,
				warned: scans,
			})
		},
		60_000,
	)
})
