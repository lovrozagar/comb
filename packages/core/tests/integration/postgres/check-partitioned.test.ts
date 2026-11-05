/**
 * Check's refusal of a REINDEX or CLUSTER Postgres runs only outside a transaction block on a
 * partitioned table or index (P9 of r21), decided by the replay on a postgres:// devUrl: comb's
 * rating reads partitioning from the history's text, which a DO block hides, so on a replayed check
 * Postgres decides, and check refuses in comb's words, which name the route, with Postgres's error
 * as the cause. Replayed or not, check refuses each of the partitioned refusal cases alike.
 */
import { describe, expect, it } from "vitest"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { replayPending } from "../../../src/migrate/core/pg-check-replay.ts"
import { P, REFUSALS } from "../support/partitioned-refusals.ts"
import { pgCheck } from "../support/pg-check.ts"

const { devUrl, files, options, targetUrl } = pgCheck()

/** Why check of `history` then `statement` refused, replayed on devUrl or not; undefined when it passed */
async function refusalOf(history: string, statement: string, replayed: boolean): Promise<Error | undefined> {
	await files(history, `${statement};\n`)
	const replay: typeof replayPending = replayed
		? replayPending
		: (at, pending) => replayPending(at, pending, () => Promise.reject(new Error("no postgres")))
	try {
		await applyWithAtlas({
			...options({ devUrl: devUrl(), url: targetUrl() }, []),
			checkOnly: true,
			replayPending: replay,
		})
		return undefined
	} catch (error) {
		return error as Error
	}
}

/** The code of Postgres's error a refusal carries as its cause */
const codeOf = (error: Error | undefined): unknown => (error?.cause as { code?: unknown } | undefined)?.code

describe("check's partitioned refusals, decided by the replay", () => {
	it.each(REFUSALS)("refuses %s alike, replayed or not", async (_label, history, statement) => {
		const replayed = await refusalOf(history, statement, true)
		const alone = await refusalOf(history, statement, false)
		expect(replayed?.message).toBe(alone?.message)
		expect(codeOf(replayed)).toBe(alone === undefined ? undefined : "25001")
	})

	const HIDDEN = "DO $$BEGIN EXECUTE 'CREATE TABLE p (id int, at date) PARTITION BY RANGE (at)'; END$$;\n"

	it("refuses a REINDEX of a table a DO block made partitioned, in comb's words", async () => {
		expect(await refusalOf(HIDDEN, "REINDEX TABLE p", false)).toBeUndefined()
		const replayed = await refusalOf(HIDDEN, "REINDEX TABLE p", true)
		expect(replayed?.message).toBe((await refusalOf(P, "REINDEX TABLE p", false))?.message)
		expect(codeOf(replayed)).toBe("25001")
	})

	it("runs a REINDEX of a table a DO block made plain where a partitioned one was", async () => {
		const plain = `${P}DO $$BEGIN EXECUTE 'DROP TABLE p'; EXECUTE 'CREATE TABLE p (id int)'; END$$;\n`
		expect(await refusalOf(plain, "REINDEX TABLE p", false)).toBeDefined()
		expect(await refusalOf(plain, "REINDEX TABLE p", true)).toBeUndefined()
	})
})
