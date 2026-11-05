/**
 * A VALIDATE after any statement of its transaction that holds a strong lock (0005, the class of PA8
 * of r22b). A VALIDATE alone takes SHARE UPDATE EXCLUSIVE and blocks nothing, but every lock an earlier
 * statement of the file took lasts to its COMMIT, so the VALIDATE's scan of every row runs under it.
 * Each case runs a statement, then the VALIDATE, as Atlas runs a file, in one transaction, reads what
 * the transaction holds from pg_locks, and holds comb's warning of the VALIDATE to it: comb warns
 * exactly when Postgres holds a lock that blocks reads or writes of a relation another session sees,
 * and names the relations it holds as Postgres does.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { withScratchDb } from "../support/pg.ts"
import { CASES, HISTORY, MAPPED, VALIDATE } from "../support/held-cases.ts"
import { heldBy, warningOf } from "../support/pg-locks.ts"

beforeAll(loadPostgresParser)

/** comb's warnings of the VALIDATE after `first`, in its file */
const validateWarnings = (first: string): string[] =>
	classifyMigration(`${first}\n${VALIDATE}\n`, {
		before: extractSchema(HISTORY, undefined, "postgres"),
		dialect: "postgres",
	}).lockWarnings.filter((warning) => warning.startsWith(`${VALIDATE.slice(0, -1)} (`))

describe("a VALIDATE after a statement of its file that holds a strong lock on Postgres 17 (0005; sibling: PA8's NOT VALID ADD)", () => {
	it.each(CASES)(
		"after %s, warns exactly when Postgres holds a blocking lock, naming what it holds",
		async (first, held) => {
			await withScratchDb(async (url) => {
				expect(await heldBy(url, [HISTORY], `${first}\n${VALIDATE}\n`)).toEqual(held)
			})
			const map = MAPPED[first]
			expect(validateWarnings(first)).toEqual(
				warningOf({ table: "users", validate: VALIDATE }, map?.held ?? held, map?.cascades),
			)
		},
		60_000,
	)
})
