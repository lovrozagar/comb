/**
 * PA17 of r22b, leaf 16.3 (c) of plan 21, as the G1 after-run's migrate-pg-atlas lock matrix runs it:
 * a table and a materialized view made without USING or TABLESPACE, then moved to heap and to
 * pg_default, where Postgres 17 put them. Postgres rewrites nothing (rewrote=[] in
 * .tmp/grunt/g1-after/2d92fc3/r22b/migrate-pg-atlas/lock/matrix.log), and check and apply warned of a
 * rewrite. Where such a relation is, its history cannot say, as the target's defaults decided it; the
 * target's catalog says, so check and apply read it there for a relation the applied history made,
 * and Postgres's relfilenode before and after the apply is the oracle. One a pending file makes, the
 * target holds nowhere yet, so a move of it still warns, as does a move elsewhere.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { run } from "../../../src/migrate/core/process.ts"
import { pgCheck } from "../support/pg-check.ts"
import { withScratchDb } from "../support/pg.ts"
import { query } from "../support/pg-roles.ts"

const { devUrl, dir, options } = pgCheck()

/* the repro's relations, each made without USING or TABLESPACE, as its HISTORY makes them */
const HISTORY = `CREATE TABLE users (id int PRIMARY KEY, n int);
CREATE INDEX users_n ON users (n);
CREATE MATERIALIZED VIEW mv AS SELECT id, n FROM users;
`

/* each move to where Postgres put the relation, which rewrites nothing */
const STAYS = [
	"ALTER TABLE users SET ACCESS METHOD heap;",
	"ALTER TABLE users SET TABLESPACE pg_default;",
	"ALTER MATERIALIZED VIEW mv SET ACCESS METHOD heap;",
	"ALTER MATERIALIZED VIEW mv SET TABLESPACE pg_default;",
	"ALTER INDEX users_n SET TABLESPACE pg_default;",
]

/** Each relation's relfilenode on `url`, by name */
const filesOf = async (url: string): Promise<Record<string, unknown>> =>
	Object.fromEntries(
		(
			await query(
				url,
				"SELECT relname, relfilenode FROM pg_class WHERE relname IN ('users', 'users_n', 'mv', 'fresh') ORDER BY relname",
			)
		).map((row) => [row["relname"], row["relfilenode"]]),
	)

/** The lock warnings among a run's printed lines */
const warned = (out: readonly string[]) => out.filter((line) => line.startsWith("Lock warning in "))

/**
 * HISTORY applied on a fresh target, then `pending` checked and applied after it: the lock warnings
 * each printed, and the relfilenodes before and after
 */
const movedAfterHistory = (pending: string) =>
	withScratchDb(async (url) => {
		const target = { devUrl: devUrl(), url }
		writeFileSync(join(dir(), "20260101000000_one.sql"), HISTORY)
		await hashDir(run, dir())
		await applyWithAtlas(options(target, []))
		writeFileSync(join(dir(), "20260102000000_two.sql"), `-- comb:allow-unsafe: the test's moves\n${pending}`)
		await hashDir(run, dir())
		const before = await filesOf(url)
		const checked: string[] = []
		await applyWithAtlas({ ...options(target, checked), checkOnly: true })
		const applied: string[] = []
		await applyWithAtlas(options(target, applied))
		return { after: await filesOf(url), applied: warned(applied), before, checked: warned(checked) }
	})

describe("a move of a relation its history made without USING or TABLESPACE (PA17 of r22b, 16.3 c)", () => {
	it("warns of nothing where the target holds it already, and Postgres rewrites nothing", async () => {
		const { after, applied, before, checked } = await movedAfterHistory(STAYS.join("\n"))
		expect(after).toEqual(before)
		expect({ applied, checked }).toEqual({ applied: [], checked: [] })
	})

	it("warns of a move of one a pending file made, which the target holds nowhere yet", async () => {
		const { applied, checked } = await movedAfterHistory(
			"CREATE TABLE fresh (id int);\nALTER TABLE fresh SET TABLESPACE pg_default;",
		)
		const warning = expect.stringContaining("ALTER TABLE fresh SET TABLESPACE pg_default (rewrites")
		expect({ applied, checked }).toEqual({ applied: [warning], checked: [warning] })
	})
})
