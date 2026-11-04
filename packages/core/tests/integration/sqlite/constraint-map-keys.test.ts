/**
 * Q4 of r19: a malformed prefix-pattern key in the maps an app passes never replaces the database
 * error. The violation is classified with the well-formed keys, the 409 the client would get with a
 * well-formed map, and the operator is told once per map, however many arrays carry it (Q5 of r20),
 * through the shared warn sink, to build the maps with defineConstraintMaps, which refuses such a
 * key at load.
 */
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { drizzle as libsqlDrizzle } from "drizzle-orm/libsql"
import pg from "pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineConstraintMaps } from "../../../src/constraint-map.ts"
import { classifyPgError } from "../../../src/pg/error-handler.ts"
import { classifySqliteError } from "../../../src/sqlite/constraint-handler.ts"
import { classifyD1Error } from "../../../src/sqlite/d1/error-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"
import { d1Memory } from "../support/d1.ts"
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

/*
 * AB4 of area B: SQLite's FOREIGN KEY message names no key, so a map listing one foreign key of the
 * table was blamed for every foreign-key failure there, and a map key naming no column was sent to
 * the client as `column`. The lone key is blamed only where the statement assigns that column; an
 * INSERT that sets no org_id, and a key that is no column, get the generic 409. author also holds
 * team_id, a key the map leaves out.
 */
const LONE_DDL = [
	"PRAGMA foreign_keys = ON",
	"CREATE TABLE org (id TEXT PRIMARY KEY)",
	"CREATE TABLE team (id TEXT PRIMARY KEY)",
	"CREATE TABLE author (id TEXT PRIMARY KEY, org_id TEXT REFERENCES org(id), team_id TEXT REFERENCES team(id))",
	"INSERT INTO org VALUES ('o1')",
	"INSERT INTO team VALUES ('t1')",
]
const ORG_NOT_FOUND = { cause: "org_id", errorKey: "org_not_found" }
const keyedBy = (key: string): ConstraintMap => ({ author: { foreignKey: { [key]: ORG_NOT_FOUND } } })
const GENERIC = { column: undefined, errorKey: "foreign_key_violation", status: 409 }

/* each statement, the map key it is classified under, and the answer */
const LONE_CASES = [
	{
		answer: GENERIC,
		key: "org_id",
		label: "an INSERT setting no org_id, its team missing",
		statement: "INSERT INTO author (id, team_id) VALUES ('a1', 'nope')",
	},
	{
		answer: GENERIC,
		key: "no_such_column",
		label: "a key naming no column",
		statement: "INSERT INTO author (id, org_id) VALUES ('a2', 'nope')",
	},
	{
		answer: GENERIC,
		key: "author_org_id_fk",
		label: "a key by constraint name",
		statement: "INSERT INTO author (id, org_id) VALUES ('a3', 'nope')",
	},
	{
		answer: GENERIC,
		key: "org_id",
		label: "an INSERT naming no columns",
		statement: "INSERT INTO author VALUES ('a4', 'nope', NULL)",
	},
	{
		answer: { column: "org_id", errorKey: "org_not_found", status: 409 },
		key: "org_id",
		label: "an INSERT setting the key, its org missing",
		statement: "INSERT INTO author (id, org_id) VALUES ('a5', 'nope')",
	},
] as const

describe("the lone foreign key a map lists is blamed only where the statement sets it (AB4 of area B; sibling: U6's UPDATE)", () => {
	it.each(LONE_CASES)("answers $label on libsql", async ({ answer, key, statement }) => {
		const client = createClient({ url: ":memory:" })
		try {
			for (const ddl of LONE_DDL) await client.execute(ddl)
			const failure = await libsqlDrizzle({ client })
				.run(sql.raw(statement))
				.then(
					() => new Error("the statement did not fail"),
					(error: unknown) => error,
				)
			expect(classifySqliteError(failure, [keyedBy(key)])).toMatchObject(answer)
		} finally {
			client.close()
		}
	})

	it.each(LONE_CASES)("answers $label on D1", async ({ answer, key, statement }) => {
		const harness = await d1Memory()
		try {
			for (const ddl of LONE_DDL.slice(1)) await harness.CORE.prepare(ddl).run()
			const failure = await drizzle(harness.CORE)
				.run(sql.raw(statement))
				.then(
					() => new Error("the statement did not fail"),
					(error: unknown) => error,
				)
			expect(classifyD1Error(failure, [keyedBy(key)])).toMatchObject(answer)
		} finally {
			await harness.dispose()
		}
	})
})
