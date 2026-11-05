/**
 * Check's held warnings measured (0005 and PA8 of r22b, after PR5): a VALIDATE scans every row under
 * each lock its file took before it, and what a DO block, a function or EXECUTE locks no rating of
 * the file's text can see. On a postgres:// devUrl check replays the file as Atlas applies it, reads
 * what its transaction holds from pg_locks before each VALIDATE, and warns of that, so the warning
 * is Postgres's: each lock oracle case reads as lock-oracle-held.test.ts holds it, a lock a DO block
 * takes is named, and a table a DO block made, which no other session sees, is not.
 */
import { describe, expect, it } from "vitest"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { replayPending } from "../../../src/migrate/core/pg-check-replay.ts"
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
			const { out, refused } = await checked(HISTORY, `${ALLOW}${first}\n${VALIDATE}\n`)
			expect(refused).toBeUndefined()
			expect(heldOf(out, VALIDATE)).toEqual(warningOf({ table: "users", validate: VALIDATE }, held))
		},
		60_000,
	)

	const NOT_VALID = `${T}ALTER TABLE t ADD CONSTRAINT c CHECK (w > 0) NOT VALID;\n`
	const VALIDATE_T = "ALTER TABLE t VALIDATE CONSTRAINT c;"

	it("names what a DO block locks, which only the replay sees", async () => {
		const two = `${ALLOW}DO $$BEGIN EXECUTE 'ALTER TABLE u ADD COLUMN x int'; END$$;\n${VALIDATE_T}\n`
		expect(heldOf(await unreplayed(NOT_VALID, two), VALIDATE_T)).toEqual([])
		const { out, refused } = await checked(NOT_VALID, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual(warningOf({ table: "t", validate: VALIDATE_T }, { u: "reads and writes" }))
	})

	it("names a table a DO block renamed by the name it has at the VALIDATE", async () => {
		const two = `${ALLOW}DO $$BEGIN EXECUTE 'ALTER TABLE u RENAME TO u2'; END$$;\n${VALIDATE_T}\n`
		expect(heldOf(await unreplayed(NOT_VALID, two), VALIDATE_T)).toEqual([])
		const { out, refused } = await checked(NOT_VALID, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual(warningOf({ table: "t", validate: VALIDATE_T }, { u2: "reads and writes" }))
	})

	it("leaves out a table a DO block made, which no other session sees", async () => {
		const two = `${ALLOW}DO $$BEGIN EXECUTE 'CREATE TABLE z (id int)'; END$$;\nALTER TABLE z ADD COLUMN y int;\n${VALIDATE_T}\n`
		expect(heldOf(await unreplayed(NOT_VALID, two), VALIDATE_T)).toEqual(
			warningOf({ table: "t", validate: VALIDATE_T }, { z: "reads and writes" }),
		)
		const { out, refused } = await checked(NOT_VALID, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual([])
	})
})
