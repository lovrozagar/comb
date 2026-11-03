/**
 * Q4 of r19: a malformed prefix-pattern key in the maps an app passes never replaces the database
 * error. The violation is classified with the well-formed keys, the 409 the client would get with a
 * well-formed map, and the operator is told once per map, however many arrays carry it (Q5 of r20),
 * through the shared warn sink, to build the maps with defineConstraintMaps, which refuses such a
 * key at load.
 */
import { createClient } from "@libsql/client"
import pg from "pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineConstraintMaps } from "../../../src/constraint-map.ts"
import { classifyPgError } from "../../../src/pg/error-handler.ts"
import { classifySqliteError } from "../../../src/sqlite/constraint-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"
import { pgUrl } from "../support/pg.ts"

afterEach(() => vi.restoreAllMocks())

const UNIQUE = { errorKey: "unique_constraint_violation" }
/* the record's maps: the violated table keyed right, a typo'd pattern key in another map */
/* a key of its own per dialect: a malformed key is warned of once per process (Q4 of r21) */
const typoed = (key: string): ConstraintMap[] => [{ member: {} }, { [key]: {} }]

/** A libsql unique violation on member.email */
async function sqliteViolation(): Promise<unknown> {
	const client = createClient({ url: ":memory:" })
	await client.executeMultiple(
		"CREATE TABLE member (id TEXT PRIMARY KEY, email TEXT UNIQUE); INSERT INTO member VALUES ('a', 'e');",
	)
	try {
		return await client.execute("INSERT INTO member VALUES ('b', 'e')").then(
			() => undefined,
			(error: unknown) => error,
		)
	} finally {
		client.close()
	}
}

/** A Postgres unique violation on member.email, in a temp table */
async function pgViolation(): Promise<unknown> {
	const client = new pg.Client({ connectionString: pgUrl() as string })
	await client.connect()
	try {
		await client.query(
			"CREATE TEMP TABLE member (id text PRIMARY KEY, email text UNIQUE); INSERT INTO member VALUES ('a', 'e')",
		)
		return await client.query("INSERT INTO member VALUES ('b', 'e')").then(
			() => undefined,
			(error: unknown) => error,
		)
	} finally {
		await client.end()
	}
}

describe.each([
	["libsql", sqliteViolation, classifySqliteError],
	["Postgres", pgViolation, classifyPgError],
] as const)("a malformed map key beside the violation's table, on %s", (dialect, violation, classify) => {
	const key = `${dialect.toLowerCase()}_*_rows`
	it("classifies the violation as with well-formed maps, and tells the operator once per key", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const error = await violation()
		const maps = typoed(key)
		expect(classify(error, maps)).toMatchObject(UNIQUE)
		expect(classify(error, maps)).toMatchObject(UNIQUE)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith(
			"comb.constraint-maps.error",
			expect.objectContaining({ key, message: expect.stringContaining("defineConstraintMaps") }),
		)
		/* the client's answer carries nothing of the app's configuration */
		expect(String(classify(error, maps)?.cause)).not.toContain(key)
	})

	it("says nothing of maps built with defineConstraintMaps", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		expect(classify(await violation(), defineConstraintMaps({ member: {} }, { "ut_*": {} }))).toMatchObject(UNIQUE)
		expect(warn).not.toHaveBeenCalled()
	})
})
