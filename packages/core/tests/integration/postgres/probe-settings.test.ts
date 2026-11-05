/**
 * AE6 of r22's condition: an every-role `comb_t.probe` setting a killed bare-replay run left is reset
 * by the Postgres projects' global setup (probe-settings.ts), logged, and a setting of any other name
 * stays. The test plants the one setting bare-replay.test.ts makes and resets it whatever happens,
 * holding the server's lock alone (tests/support/server-lock.ts).
 * Sibling: the scratch sweep the same setup runs (scratch-sweep.test.ts).
 */
import pg from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { pgUrl } from "../support/pg.ts"
import { resetProbeSettings } from "../support/probe-settings.ts"
import { writingServer } from "../../support/server-lock.ts"

let admin: pg.Client
beforeEach(async () => {
	admin = new pg.Client({ connectionString: pgUrl() })
	await admin.connect()
})
afterEach(() => admin.end())

/** The every-role settings the server holds, as name=value */
async function everyRole(): Promise<string[]> {
	const { rows } = await admin.query<{ c: string }>(
		"SELECT unnest(setconfig) AS c FROM pg_db_role_setting WHERE setrole = 0 AND setdatabase = 0",
	)
	return rows.map(({ c }) => c)
}

describe("resetProbeSettings", () => {
	it("resets the comb_t.probe setting a killed run left for every role, saying so", async () => {
		/* every role's setting is about `all`, which another test's checked file may spell (server-lock.ts) */
		await writingServer(async () => {
			try {
				process.stderr.write("[comb] AE6 catalog: ALTER ROLE ALL SET comb_t.probe = 'leaked'\n")
				await admin.query("ALTER ROLE ALL SET comb_t.probe = 'leaked'")
				expect(await everyRole()).toContain("comb_t.probe=leaked")
				const lines: string[] = []
				expect(await resetProbeSettings(admin, { log: (line) => lines.push(line) })).toEqual({
					reset: ["comb_t.probe"],
				})
				expect(await everyRole()).not.toContain("comb_t.probe=leaked")
				expect(lines).toEqual([`[comb] probe settings: ALTER ROLE ALL RESET "comb_t"."probe", which a killed run left`])
			} finally {
				process.stderr.write("[comb] AE6 catalog: ALTER ROLE ALL RESET comb_t.probe\n")
				await admin.query("ALTER ROLE ALL RESET comb_t.probe")
			}
		})
	})

	it("resets nothing on a server with no comb_t setting left", async () => {
		expect(await resetProbeSettings(admin, { log: () => undefined })).toEqual({ reset: [] })
	})
})
