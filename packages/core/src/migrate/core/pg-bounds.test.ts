/**
 * PA16 of r22b: once the ATTACH recipe is followed, a CHECK matching the bound added NOT VALID and
 * validated in an earlier file, Postgres 17 skips the partition's scan (2M rows attached in 8 ms
 * against 99 ms without the CHECK, .tmp/grunt/r22b/migrate-pg-atlas/lock/attach-after-recipe.log),
 * and comb warns of nothing. comb proves the bound as pg-bounds.ts says, and every case it cannot
 * prove keeps the scan's warning: the siblings below, each one way the proof fails.
 * tests/integration/postgres/attach-implied-oracle.test.ts holds both sides to Postgres.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"
import { ATTACH, IMPLIED, PARENT, PARTITION, SCANNED, SCANS } from "../../../tests/support/attach-cases.ts"

/** `attach`'s lock warnings after `history`, read as Postgres */
const warned = (history: string, attach = ATTACH): string[] =>
	classifyMigration(attach, { before: extractSchema(history, undefined, "postgres"), dialect: "postgres" }).lockWarnings

describe("an ATTACH whose bound the history's validated CHECKs imply (PA16 of r22b)", () => {
	it.each(IMPLIED)("warns of nothing for %s", (_case, history, attach) => {
		expect(warned(history, attach)).toEqual([])
	})

	it("warns of the default partition's scan alone when the parent has one", () => {
		const history = `${PARENT}CREATE TABLE ev_rest PARTITION OF ev DEFAULT;\n${PARTITION}`
		expect(warned(history)).toEqual([
			expect.stringContaining(
				"(scans the default partition ev_rest under an exclusive lock for rows o's bound takes; add a CHECK constraint excluding the bound to ev_rest NOT VALID, VALIDATE it in a later file, then ATTACH)",
			),
		])
	})
})

describe("an ATTACH whose bound comb cannot prove keeps the scan's warning (siblings of PA16 of r22b)", () => {
	it.each(SCANNED)("warns of the scan for %s", (_case, history, attach) => {
		expect(warned(history, attach)).toEqual([expect.stringContaining("under an exclusive lock to check its bound")])
	})

	it("keeps the default partition's own warning when the partition attaches as it", () => {
		expect(warned(`${PARENT}${PARTITION}`, "ALTER TABLE ev ATTACH PARTITION o DEFAULT;")).toEqual([
			expect.stringContaining("scans o under an exclusive lock for rows another partition's bound takes"),
		])
		expect(SCANS).toContain("check its bound")
	})
})
