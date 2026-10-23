/**
 * M30 of the 0.13 review: every name on comb's list of pure built-ins is a function Postgres 17
 * has, and one it marks immutable or stable, so it writes nothing: the few volatile ones that still
 * write nothing (a random value, the clock) are named here, and the extensions' are left out, as the
 * gate database installs none.
 */
import { describe, expect, it } from "vitest"
import { PURE_BUILTINS } from "../../../src/migrate/core/pg-builtins.ts"
import { usePg } from "../support/pg.ts"

/* volatile only because a call's value may change between calls: each reads the clock, a random
   source or the session's last sequence value, and writes nothing */
const VOLATILE = new Set(["clock_timestamp", "currval", "gen_random_uuid", "lastval", "random"])
/* uuid-ossp's, unaccent's and pgcrypto's: no extension is installed on the gate database */
const EXTENSIONS = new Set(["digest", "unaccent", "uuid_generate_v1", "uuid_generate_v4"])

describe("comb's pure Postgres built-ins, against pg_proc", () => {
	const sessions = usePg()

	it("are each a function of Postgres 17 marked immutable or stable, the named volatile ones aside", async () => {
		const listed = [...PURE_BUILTINS].filter((name) => !EXTENSIONS.has(name))
		const { rows } = await sessions
			.pg()
			.query<{ name: string; volatility: string[] }>(
				"SELECT proname AS name, array_agg(DISTINCT provolatile::text) AS volatility FROM pg_proc WHERE pronamespace = 'pg_catalog'::regnamespace AND proname = ANY($1) GROUP BY proname",
				[listed],
			)
		const found = new Map(rows.map((row) => [row.name, row.volatility]))
		expect(listed.filter((name) => !found.has(name))).toEqual([])
		const volatile = listed.filter((name) => !VOLATILE.has(name) && found.get(name)?.includes("v") === true)
		expect(volatile).toEqual([])
	})
})
