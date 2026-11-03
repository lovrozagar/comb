/**
 * A replayed history file paused until the test lets it go, for the suites that act beside a replay
 * in flight. The go is a session the test opens under the pause's name, which the file finds in
 * pg_stat_activity, read afresh each turn as one transaction keeps its first read: a session is no
 * row of the server's shared catalogs, which the replay reads around a file and refuses a change to
 * when the file names it (P2 of r22), as it would a role the test made for the go.
 */
import pg from "pg"
import { afterEach } from "vitest"
import { pgUrl } from "./pg.ts"

/** A statement that waits, at most a minute, until the test lets `name` go */
export const waitFor = (name: string): string =>
	`DO $$ BEGIN FOR i IN 1..1200 LOOP EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${name}'); PERFORM pg_sleep(0.05); PERFORM pg_stat_clear_snapshot(); END LOOP; END $$;\n`

/** The pause harness: call once at a test file's top level; each go's session ends with its test */
export function pauses(): { go(name: string): Promise<void> } {
	const held: pg.Client[] = []
	afterEach(async () => {
		await Promise.all(held.splice(0).map((session) => session.end()))
	})
	return {
		/** Lets every waitFor(`name`) go, until the test ends */
		async go(name) {
			const session = new pg.Client({ application_name: name, connectionString: pgUrl() })
			held.push(session)
			await session.connect()
		},
	}
}
