/** U32 on D1 (Miniflare's workerd SQLite): the generator's FTS tokenizer is taken, and finds words whole */
import { afterEach, describe, expect, it } from "vitest"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import { MATCHES, matchSql, SETUP } from "../support/fts-tokenizer.ts"

let harness: D1Harness | undefined
afterEach(async () => {
	await harness?.dispose()
	harness = undefined
})

describe("the generated FTS tokenizer on D1 (U32)", () => {
	it.each(MATCHES)("finds %s as the rows %j", async (term, ids) => {
		harness = await d1Memory()
		for (const statement of SETUP) await harness.CORE.prepare(statement).run()
		const rows = await harness.CORE.prepare(matchSql(term)).all<{ id: number }>()
		expect(rows.results.map((row) => row.id)).toEqual(ids)
	})
})
