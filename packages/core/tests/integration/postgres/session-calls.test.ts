/**
 * pg-session-calls.ts held to the server's own pg_proc (PA1 of r22b): each pg_catalog name comb
 * lets a run share a session past is a function Postgres holds there, immutable or stable on every
 * overload, so it changes nothing a later file reads, unless comb names it a volatile one that
 * leaves no session state; currval and lastval, which read what the session left, are there too.
 */
import { describe, expect, it } from "vitest"
import { CATALOG_CALLS, READS_SESSION, VOLATILE_HARMLESS } from "../../../src/migrate/core/pg-session-calls.ts"
import { pgUrl } from "../support/pg.ts"
import { query } from "../support/pg-roles.ts"

/** Each of `names` in pg_catalog, with the volatilities of its overloads */
async function volatilities(names: ReadonlySet<string>): Promise<Record<string, string[]>> {
	const rows = await query(
		pgUrl(),
		`SELECT proname, array_agg(DISTINCT provolatile::text ORDER BY provolatile::text) AS v FROM pg_proc WHERE pronamespace = 'pg_catalog'::regnamespace AND proname = ANY('{${[...names].join(",")}}'::text[]) GROUP BY proname`,
	)
	return Object.fromEntries(rows.map((row) => [String(row["proname"]), row["v"] as string[]]))
}

describe("the pg_catalog calls a run of files shares a session past (PA1 of r22b)", () => {
	it("names only functions Postgres holds in pg_catalog, immutable or stable on every overload past the volatile ones comb names and the session's readers, which start a run", async () => {
		const held = await volatilities(CATALOG_CALLS)
		const missing = [...CATALOG_CALLS].filter((name) => held[name] === undefined)
		const volatile = Object.entries(held)
			.filter(([name, kinds]) => kinds.includes("v") && !VOLATILE_HARMLESS.has(name) && !READS_SESSION.has(name))
			.map(([name]) => name)
		expect({ missing, volatile }).toEqual({ missing: [], volatile: [] })
	})

	it("names volatile ones and the session's readers Postgres holds there", async () => {
		const names = new Set([...VOLATILE_HARMLESS, ...READS_SESSION])
		expect(Object.keys(await volatilities(names)).sort()).toEqual([...names].sort())
	})
})
