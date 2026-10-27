/** U32 on libsql: the generator's FTS tokenizer is taken, and finds words whole */
import { afterEach, describe, expect, it } from "vitest"
import { MATCHES, matchSql, SETUP } from "../support/fts-tokenizer.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"

const open: LibsqlHarness[] = []
afterEach(() => {
	for (const harness of open.splice(0)) harness.close()
})

describe("the generated FTS tokenizer on libsql (U32)", () => {
	it.each(MATCHES)("finds %s as the rows %j", async (term, ids) => {
		const harness = libsqlMemory()
		open.push(harness)
		for (const statement of SETUP) await harness.client.execute(statement)
		const rows = await harness.client.execute(matchSql(term))
		expect(rows.rows.map((row) => Number(row["id"]))).toEqual(ids)
	})
})
