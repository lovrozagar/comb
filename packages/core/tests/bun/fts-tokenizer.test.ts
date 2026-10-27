/// <reference types="bun-types" />
/** U32 on bun:sqlite: the generator's FTS tokenizer is taken, and finds words whole; tests/integration runs it on D1 and libsql */
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { MATCHES, matchSql, SETUP } from "../integration/support/fts-tokenizer.ts"

describe("the generated FTS tokenizer on bun:sqlite (U32)", () => {
	for (const [term, ids] of MATCHES)
		it(`finds ${term} as the rows ${JSON.stringify(ids)}`, () => {
			const db = new Database(":memory:")
			for (const statement of SETUP) db.run(statement)
			expect(
				db
					.query<{ id: number }, []>(matchSql(term))
					.all()
					.map((row) => row.id),
			).toEqual(ids)
			db.close()
		})
})
