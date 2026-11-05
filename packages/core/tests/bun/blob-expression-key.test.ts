/// <reference types="bun-types" />
/**
 * B2-5 of area B on bun:sqlite: an expression over a blob reads as a Uint8Array, which the cursor
 * carries as bytes, and the next page refused that cursor as `invalid_cursor`, a 400.
 */
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { BLOB_SEED, BLOB_SERVED, servedBlob } from "../integration/support/blob-key.ts"

describe("an expression over a blob pages by its bytes on bun:sqlite (B2-5 of area B)", () => {
	it("pages an anchored and an anchorless list sorted by an expression over a blob, every row once", async () => {
		const client = new Database(":memory:")
		for (const statement of BLOB_SEED) client.run(statement)
		/* bun:sqlite's database is a sync one, which the helper awaits as it awaits an async one */
		const db = drizzle({ client }) as never
		for (const shape of ["anchored", "anchorless"] as const)
			for (const direction of ["asc", "desc"] as const)
				expect(await servedBlob(db, { direction, shape })).toEqual([...BLOB_SERVED[direction]])
		client.close()
	})
})
