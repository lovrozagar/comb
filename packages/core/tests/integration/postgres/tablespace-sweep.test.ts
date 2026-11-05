/**
 * PR5 of r22b's condition: a `comb_t_*` in-place tablespace a killed replay-left-out.test.ts run left
 * is dropped by the Postgres projects' global setup (tablespace-sweep.ts), logged, and one that still
 * holds a relation is kept and said. The relation is a temporary table of a second session, gone with
 * it, so the test leaves nothing past the tablespaces it drops whatever happens.
 * Sibling: the probe settings the same setup resets (probe-settings.test.ts).
 */
import pg from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { pgUrl } from "../support/pg.ts"
import { unique } from "../support/pg-roles.ts"
import { sweepTablespaces } from "../support/tablespace-sweep.ts"

let admin: pg.Client
const made: string[] = []
beforeEach(async () => {
	admin = new pg.Client({ connectionString: pgUrl() })
	await admin.connect()
	await admin.query("SET allow_in_place_tablespaces = on")
})
afterEach(async () => {
	for (const name of made.splice(0)) {
		process.stderr.write(`[comb] PR5 catalog: DROP TABLESPACE IF EXISTS ${name}\n`)
		await admin.query(`DROP TABLESPACE IF EXISTS ${name}`)
	}
	await admin.end()
})

/** A `comb_t_fast_*` tablespace made in place on the test server, dropped after the test */
async function tablespace(): Promise<string> {
	const name = unique("comb_t_fast")
	process.stderr.write(`[comb] PR5 catalog: CREATE TABLESPACE ${name} LOCATION ''\n`)
	await admin.query(`CREATE TABLESPACE ${name} LOCATION ''`)
	made.push(name)
	return name
}

const left = async (name: string): Promise<boolean> =>
	(await admin.query("SELECT 1 FROM pg_tablespace WHERE spcname = $1", [name])).rows.length > 0

describe("sweepTablespaces", () => {
	it("drops a comb_t tablespace a killed run left, saying so", async () => {
		const name = await tablespace()
		const lines: string[] = []
		expect(await sweepTablespaces(admin, { log: (line) => lines.push(line) })).toEqual({ dropped: [name], kept: [] })
		expect(await left(name)).toBe(false)
		expect(lines).toEqual([`[comb] tablespace sweep: DROP TABLESPACE "${name}", which a killed run left`])
	})

	it("keeps a comb_t tablespace that still holds a relation, saying why", async () => {
		const name = await tablespace()
		const holder = new pg.Client({ connectionString: pgUrl() })
		await holder.connect()
		try {
			await holder.query(`CREATE TEMPORARY TABLE held (id int) TABLESPACE ${name}`)
			const lines: string[] = []
			expect(await sweepTablespaces(admin, { log: (line) => lines.push(line) })).toEqual({ dropped: [], kept: [name] })
			expect(await left(name)).toBe(true)
			expect(lines).toEqual([`[comb] tablespace sweep keeps ${name}: tablespace "${name}" is not empty`])
		} finally {
			await holder.end()
		}
	})

	it("drops nothing on a server with no comb_t tablespace left", async () => {
		expect(await sweepTablespaces(admin, { log: () => undefined })).toEqual({ dropped: [], kept: [] })
	})
})
