/**
 * CD2 of r22b on a Postgres server: a `c.json` schema whose output parses again stores, through
 * drizzle's node-postgres driver into jsonb, the document the read DTO takes. The codegen half and
 * SQLite's round trip are json-stored-document.test.ts's, which macOS runs too.
 */
import { drizzle } from "drizzle-orm/node-postgres"
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos } from "../support/dtos.ts"
import { KEPT, type Kept, roundTrip, rowDdl, type Store } from "../support/json-stored-document.ts"
import { usePg } from "../support/pg.ts"

afterAll(() => cleanGeneratedDtos())

describe("a c.json schema is the stored document (CD2) on postgres", () => {
	const sessions = usePg()

	const store: Store = async (tables, value) => {
		await sessions.pg().query(rowDdl("postgres"))
		const db = drizzle({ client: sessions.pg() })
		await db.insert(tables.row).values({ doc: value, id: "r1" } as never)
		return ((await db.select().from(tables.row)) as Array<{ doc: unknown }>)[0]?.doc
	}

	it.each(KEPT)("keeps $kind, whose stored row the read DTO takes", async (kept: Kept) => {
		const { read, stored } = await roundTrip(kept, "postgres", store)
		expect(stored).toEqual(kept.stored)
		expect(read).toBe(true)
	})
})
