import { describe, expect, it } from "vitest"
import { PG_URL_VAR, pgUrl, usePg } from "../support/pg.ts"

describe("pg harness: configuration", () => {
	/* a run without the server would pass with the Postgres suites skipped, and a verify stamp would
	   vouch for it: an unset URL fails the run, locally as in CI */
	it("uses the URL when set and refuses an unset or empty one, locally as in CI", () => {
		expect(pgUrl({ [PG_URL_VAR]: "postgres://x" })).toBe("postgres://x")
		expect(() => pgUrl({})).toThrow(`${PG_URL_VAR} is unset: the Postgres suites are required`)
		expect(() => pgUrl({ [PG_URL_VAR]: "" })).toThrow(`${PG_URL_VAR} is unset`)
		expect(() => pgUrl({ CI: "true" })).toThrow(`${PG_URL_VAR} is unset`)
	})
})

describe("pg harness: server", () => {
	const sessions = usePg()

	it("runs node-postgres and postgres.js against TEMP tables", async () => {
		await sessions.pg().query("CREATE TEMP TABLE note (id int PRIMARY KEY, body text NOT NULL)")
		await sessions.pg().query("INSERT INTO note VALUES ($1, $2)", [1, "a"])
		const { rows } = await sessions.pg().query("SELECT id, body FROM note")
		expect(rows).toEqual([{ body: "a", id: 1 }])

		const sql = sessions.sql()
		await sql`CREATE TEMP TABLE note (id int PRIMARY KEY)`
		await sql`INSERT INTO note VALUES (${7})`
		expect(await sql`SELECT id FROM note`).toEqual([{ id: 7 }])
	})

	it("starts every test on fresh sessions: the last test's TEMP tables are gone", async () => {
		await expect(sessions.pg().query("SELECT 1 FROM note")).rejects.toMatchObject({ code: "42P01" })
		await expect(sessions.sql()`SELECT 1 FROM note`).rejects.toMatchObject({ code: "42P01" })
	})

	it("surfaces SQLSTATE and the constraint name from both drivers", async () => {
		await sessions.pg().query("CREATE TEMP TABLE u (email text CONSTRAINT u_email_key UNIQUE)")
		await sessions.pg().query("INSERT INTO u VALUES ('x')")
		await expect(sessions.pg().query("INSERT INTO u VALUES ('x')")).rejects.toMatchObject({
			code: "23505",
			constraint: "u_email_key",
		})
		const sql = sessions.sql()
		await sql`CREATE TEMP TABLE u (email text CONSTRAINT u_email_key UNIQUE)`
		await sql`INSERT INTO u VALUES ('x')`
		await expect(sql`INSERT INTO u VALUES ('x')`).rejects.toMatchObject({
			code: "23505",
			constraint_name: "u_email_key",
		})
	})
})
