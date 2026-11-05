/**
 * A check run in a process of its own, for a test to signal mid-replay (P2 of r21): the directory
 * and the target come as JSON in argv[2]. It writes its pid first, and a line for each replay
 * database it drops as it sends the drop, so a test reads how often the cleanup ran however the
 * process ends.
 */
import { writeSync } from "node:fs"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { replayPending } from "../../../src/migrate/core/pg-check-replay.ts"
import { type Connect, loadPostgres } from "../../../src/migrate/core/pg-live-objects.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import type { ParsedMigration } from "../../../src/migrate/migration-types.ts"

const { devUrl, dir, url } = JSON.parse(process.argv[2] as string) as { devUrl: string; dir: string; url: string }

/** postgres.js, each replay database's drop written out as it is sent */
async function counted(): Promise<Connect> {
	const connect = await loadPostgres("replay in a test's child")
	return (options) => {
		const sql = connect(options)
		const unsafe = sql.unsafe.bind(sql)
		return Object.assign(sql, {
			unsafe: (query: string, params?: unknown[]) => {
				if (query.startsWith("DROP DATABASE IF EXISTS comb_replay_")) writeSync(1, `drop ${query.split(" ").at(-1)}\n`)
				return unsafe(query, params as never)
			},
		})
	}
}

await loadPostgresParser()
writeSync(1, `pid ${process.pid}\n`)
await applyWithAtlas({
	approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
	checkOnly: true,
	dir,
	print: (line) => writeSync(1, `${line}\n`),
	replayPending: (options, files) => replayPending(options, files, counted),
	target: { devUrl, lockTimeout: "5s", schema: "public", url },
})
writeSync(1, "passed\n")
