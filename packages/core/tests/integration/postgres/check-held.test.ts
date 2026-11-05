/**
 * Check's held warnings measured (0005 and PA8 of r22b, after PR5): a VALIDATE scans every row under
 * each lock its file took before it, and what a DO block, a function or EXECUTE locks no rating of
 * the file's text can see. On a postgres:// devUrl check replays the file as Atlas applies it, reads
 * what its transaction holds from pg_locks before each VALIDATE, and warns of that, so the warning
 * is Postgres's: each lock oracle case reads as lock-oracle-held.test.ts holds it, a lock a DO block
 * takes is named, and a table a DO block made, which no other session sees, is not. apply, and check
 * where it replays nothing, warn from pg-held.ts's map of the file's text, so each case also holds
 * that map to hold all the replay measures, but for what UNSEEN names, which no reading of the text sees.
 */
import { describe, expect, it } from "vitest"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { replayPending } from "../../../src/migrate/core/pg-check-replay.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { CASES, HISTORY, VALIDATE } from "../support/held-cases.ts"
import { pgCheck, T } from "../support/pg-check.ts"
import { warningOf } from "../support/pg-locks.ts"

const { checked, devUrl, files, options, targetUrl } = pgCheck()

/* the pending file's own approval, so a case's unsafe statement passes and its warnings print */
const ALLOW = "-- comb:allow-unsafe: the test's pending file\n"
const WARNING = "Lock warning in 20260102000000_two.sql: "

/** The warnings `out` prints of `validate`, the pending file's VALIDATE */
const heldOf = (out: readonly string[], validate: string): string[] =>
	out
		.filter((line) => line.startsWith(`${WARNING}${validate.slice(0, -1)} (`))
		.map((line) => line.slice(WARNING.length))

/** What a warning of `validate`, a VALIDATE on `table`, says its file holds, read so warningOf writes it back */
function heldIn(lines: readonly string[], { table, validate }: { table: string; validate: string }) {
	const held: Record<string, string> = {}
	const holding = /while this file holds (.*); those locks/.exec(lines[0] ?? "")?.[1] ?? ""
	if (holding.startsWith("it locked against ")) held[table] = holding.slice("it locked against ".length)
	else
		for (const part of holding === "" ? [] : holding.split(", and ")) {
			const [, names, blocks] = /^(.*?)(?: locked)? against (reads and writes|writes)$/.exec(part) ?? []
			for (const name of String(names).split(/, | and /)) held[name] = String(blocks)
		}
	expect(warningOf({ table, validate }, held)).toEqual(lines)
	return held
}

/** What pg-held.ts's map of `two` after `one` holds at `validate`, a VALIDATE on `table`, as apply warns of it */
function mapped(one: string, two: string, at: { table: string; validate: string }): Record<string, string> {
	const { lockWarnings } = classifyMigration(two, {
		before: extractSchema(one, undefined, "postgres"),
		dialect: "postgres",
	})
	return heldIn(
		lockWarnings.filter((line) => line.startsWith(`${at.validate.slice(0, -1)} (`)),
		at,
	)
}

/** Whether `map` holds each relation `measured` does, as strongly: reads and writes, or writes at least */
const holdsAll = (map: Readonly<Record<string, string>>, measured: Readonly<Record<string, string>>): boolean =>
	Object.entries(measured).every(([name, blocks]) => map[name] === blocks || map[name] === "reads and writes")

// lookup-table: what the replay measures and pg-held.ts's map cannot, by why; apply warns without it, so run check first
const UNSEEN = {
	dynamic:
		"a lock a DO block, a function or EXECUTE takes: the map reads the file's text, and their SQL is a string run later",
	renamed: "a table a DO block renamed: the map goes by the name the text gives it, which the DO body changed",
} as const

/**
 * That pg-held.ts's map of `two` after `one` holds all the replay printed in `out` at `at`'s VALIDATE,
 * or, for a case UNSEEN names by `unseen`, that it misses some of it
 */
function mapHolds(
	{ one, out, two }: { one: string; out: readonly string[]; two: string },
	at: { table: string; validate: string },
	unseen?: keyof typeof UNSEEN,
): void {
	expect(holdsAll(mapped(one, two, at), heldIn(heldOf(out, at.validate), at)), unseen && UNSEEN[unseen]).toBe(
		unseen === undefined,
	)
}

/** What check prints of `one` then `two` when it replays nothing, as without the postgres package */
async function unreplayed(one: string, two: string): Promise<string[]> {
	await files(one, two)
	const out: string[] = []
	await applyWithAtlas({
		...options({ devUrl: devUrl(), url: targetUrl() }, out),
		checkOnly: true,
		replayPending: (at, pending) => replayPending(at, pending, () => Promise.reject(new Error("no postgres"))),
	})
	return out
}

describe("check's held warnings, measured on devUrl", () => {
	it.each(CASES)(
		"after %s, warns of what Postgres holds at the VALIDATE",
		async (first, held) => {
			const two = `${ALLOW}${first}\n${VALIDATE}\n`
			const { out, refused } = await checked(HISTORY, two)
			expect(refused).toBeUndefined()
			expect(heldOf(out, VALIDATE)).toEqual(warningOf({ table: "users", validate: VALIDATE }, held))
			mapHolds({ one: HISTORY, out, two }, { table: "users", validate: VALIDATE })
		},
		60_000,
	)

	const NOT_VALID = `${T}ALTER TABLE t ADD CONSTRAINT c CHECK (w > 0) NOT VALID;\n`
	const VALIDATE_T = "ALTER TABLE t VALIDATE CONSTRAINT c;"
	const AT_T = { table: "t", validate: VALIDATE_T }

	it("names what a DO block locks, which only the replay sees", async () => {
		const two = `${ALLOW}DO $$BEGIN EXECUTE 'ALTER TABLE u ADD COLUMN x int'; END$$;\n${VALIDATE_T}\n`
		expect(heldOf(await unreplayed(NOT_VALID, two), VALIDATE_T)).toEqual([])
		const { out, refused } = await checked(NOT_VALID, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual(warningOf({ table: "t", validate: VALIDATE_T }, { u: "reads and writes" }))
		mapHolds({ one: NOT_VALID, out, two }, AT_T, "dynamic")
	})

	it("names a table a DO block renamed by the name it has at the VALIDATE", async () => {
		const two = `${ALLOW}DO $$BEGIN EXECUTE 'ALTER TABLE u RENAME TO u2'; END$$;\n${VALIDATE_T}\n`
		expect(heldOf(await unreplayed(NOT_VALID, two), VALIDATE_T)).toEqual([])
		const { out, refused } = await checked(NOT_VALID, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual(warningOf({ table: "t", validate: VALIDATE_T }, { u2: "reads and writes" }))
		mapHolds({ one: NOT_VALID, out, two }, AT_T, "renamed")
	})

	it("leaves out a table a DO block made, which no other session sees", async () => {
		const two = `${ALLOW}DO $$BEGIN EXECUTE 'CREATE TABLE z (id int)'; END$$;\nALTER TABLE z ADD COLUMN y int;\n${VALIDATE_T}\n`
		expect(heldOf(await unreplayed(NOT_VALID, two), VALIDATE_T)).toEqual(
			warningOf({ table: "t", validate: VALIDATE_T }, { z: "reads and writes" }),
		)
		const { out, refused } = await checked(NOT_VALID, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual([])
		/* the map names z, which Postgres does not: more than the replay measures, never less */
		mapHolds({ one: NOT_VALID, out, two }, AT_T)
	})
})
