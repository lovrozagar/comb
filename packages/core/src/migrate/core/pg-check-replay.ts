/**
 * Check lets Postgres decide what no database runs (P13 of r19). On a postgres:// devUrl it replays
 * the history and the pending files on its server as Atlas applies them, baseline's own replay
 * (pg-replay.ts), and a statement Postgres refuses stops check with Postgres's message: a retype of
 * a column a view, a materialized view, a rule, a policy, a trigger's WHEN, a generated column or a
 * BEGIN ATOMIC function reads, and whatever else Postgres refuses on an empty database, which no
 * rating of the statement's text can list. Each statement whose scope is the server or another
 * database is left out, and check names it. A docker:// devUrl is Atlas's
 * own container, which comb cannot reach, and without the `postgres` package comb cannot connect:
 * then check says the replay did not run, and rates the files alone.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sqlFiles } from "./atlas-dir.ts"
import type { PgTarget } from "./atlas-target.ts"
import { type Connect, loadPostgres } from "./pg-live-objects.ts"
import { type HistoryFile, onDev } from "./pg-replay.ts"

/* why comb loads postgres.js here */
const REPLAYS = "replay the history and the pending files on devUrl in a check"

/* the line check prints when it replays nothing, and why */
const NOT_REPLAYED = "Check did not replay the pending files on devUrl"

/**
 * The history and the pending `files`, in order, replayed on `target`'s dev server as Atlas applies
 * them; throws, naming the statement and dev's error, for one dev refuses
 */
async function replayPending(
	{ print, target }: { print(line: string): void; target: PgTarget },
	files: readonly HistoryFile[],
	load: () => Promise<Connect> = () => loadPostgres(REPLAYS),
): Promise<void> {
	if (target.devUrl.startsWith("docker:")) {
		print(
			`${NOT_REPLAYED}: ${target.devUrl} is Atlas's own container, which comb cannot reach, so a statement Postgres refuses on every database is found only when it applies; set devUrl to a postgres:// scratch database comb can connect to`,
		)
		return
	}
	let connect: Connect
	try {
		connect = await load()
	} catch (error) {
		// reason: the postgres package is an optional peer; without it check rates the files alone, and says so
		print(`${NOT_REPLAYED}: ${(error as Error).message}`)
		return
	}
	await onDev(target, files, {
		after: async () => undefined,
		doing: "check replayed the history and the pending files there",
		leftOut: (file, sent, what) =>
			print(
				`Check left ${JSON.stringify(sent)} in ${file} out of its replay on devUrl: ${what} reaches past the database the replay runs in, so apply alone runs it`,
			),
		load: async () => connect,
		stops: "check applies nothing",
	})
}

/** The snapshot `copy`'s files through the last of `pending`, in order, as check replays them */
function throughPending(copy: string, pending: readonly string[]): HistoryFile[] {
	const names = sqlFiles(copy)
	return names
		.slice(0, names.indexOf(pending.at(-1) as string) + 1)
		.map((name) => ({ name, sql: readFileSync(join(copy, name), "utf8") }))
}

export { replayPending, throughPending }
