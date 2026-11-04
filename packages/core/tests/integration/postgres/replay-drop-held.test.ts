/**
 * r22b: a replay's cleanup whose drop fails says what it left, never drops it silently. A
 * superuser's session in the replay database holds it across the drop, as a dev role without
 * SUPERUSER may end no superuser's backend, so neither the cleanup's terminate nor DROP DATABASE's
 * FORCE ends it, as a person's psql may.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import { pgUrl, withScratchDb } from "../support/pg.ts"
import { waitFor } from "../support/pg-pause.ts"
import { asRole, unique } from "../support/pg-roles.ts"
import { childCheck, dropRoles, endedWithin, replayDatabases, untilRole } from "../support/replay-check.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-replay-drop-held-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const UNSAFE = "-- comb:allow-unsafe: the test's history\n"

/** The files, named in order and hashed, in `at` */
async function write(files: readonly string[], at = dir): Promise<void> {
	files.forEach((sql, i) => writeFileSync(join(at, `20260101${String(i).padStart(6, "0")}_f${i}.sql`), sql))
	await hashDir(run, at)
}

/** A history that makes `made` and then waits, at most a minute, until the test lets `resume` go */
const paused = (made: string, resume: string, role = `CREATE ROLE ${made};`): string[] => [
	`${UNSAFE}${role}\nCREATE TABLE t (id int PRIMARY KEY);\nGRANT SELECT ON t TO ${made};\n`,
	`${UNSAFE}${waitFor(resume)}`,
]

describe("a check killed mid-replay whose database a session holds across the drop", () => {
	it("says the database and the role it could not drop, and ends as the signal would", async () => {
		const [made, resume, mgr] = [unique("comb_t_killed"), unique("comb_t_resume"), unique("comb_t_holdmgr")]
		let holder: pg.Client | undefined
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					await write(paused(made, resume))
					const child = childCheck(await asRole(dev, mgr, "CREATEDB CREATEROLE"), url, dir)
					await untilRole(made)
					const [database] = await replayDatabases(made)
					const at = new URL(pgUrl())
					at.pathname = `/${database}`
					holder = new pg.Client({ connectionString: at.toString() })
					holder.on("error", () => undefined)
					await holder.connect()
					await child.kill("SIGTERM")
					const said = await endedWithin(child)
					expect(said.at(-1)).toBe("exit 143")
					const left = "which a replay left on devUrl's server: "
					const swept = "; the next check or apply that reaches that server drops it$"
					expect(said.filter((line) => line.startsWith("comb could not drop"))).toEqual([
						expect.stringMatching(new RegExp(`^comb could not drop database ${database}, ${left}.+${swept}`)),
						expect.stringMatching(new RegExp(`^comb could not drop role ${made}, ${left}.+${swept}`)),
					])
				}),
			)
		} finally {
			await holder?.end().catch(() => undefined)
			await dropRoles(made, mgr)
		}
	}, 60_000)
})
