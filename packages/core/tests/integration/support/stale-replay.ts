/**
 * What a replay left, which a sweep takes, is the whole test server's: every apply looks for it there
 * before it connects to devUrl (PR7 of r22b), whichever file left it. So each test of a describe that
 * leaves it, by a plant or a killed check, holds this lock shared, and each of one that needs a server
 * holding none of it holds the lock alone; run beside replay-database's 0.19 plant, PR7's test saw
 * one and dialed devUrl.
 */
import pg from "pg"
import { afterEach, beforeEach } from "vitest"
import { pgUrl } from "./pg.ts"

/* the advisory lock both take, in a key pair no comb run or other test takes */
const KEY = "hashtext('comb test'), hashtext('a replay left')"

/** Each test of the describe this is called in, run holding the lock in `mode` on its own session */
function holding(mode: "alone" | "shared"): void {
	let session: pg.Client | undefined
	beforeEach(async () => {
		session = new pg.Client({ connectionString: pgUrl() })
		await session.connect()
		await session.query(`SELECT ${mode === "shared" ? "pg_advisory_lock_shared" : "pg_advisory_lock"}(${KEY})`)
	})
	afterEach(() => session?.end())
}

/** The describe's tests leave on the server what a replay left, and take it before each ends */
export const leavesStale = (): void => holding("shared")

/** The describe's tests need a server holding nothing a replay left while each runs */
export const needsNothingStale = (): void => holding("alone")
