/**
 * The classification of Atlas's own rebuild copies, on the real Atlas: a column made NOT NULL with
 * a default comes back as `IFNULL(<column>, <its new default>)`, which keeps every row, so the
 * rebuild rates cautious; a column retyped to another affinity changes what lands, so it is unsafe.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"

import { history } from "../support/rebuild-guard.ts"

const BEFORE = "CREATE TABLE `t` (`id` text PRIMARY KEY, `a` integer, `b` text, `c` integer, `d` text, `e` real);"
const AFTER =
	"CREATE TABLE `t` (`id` text PRIMARY KEY, `a` integer NOT NULL DEFAULT (unixepoch() * 1000), `b` text NOT NULL DEFAULT CURRENT_TIMESTAMP, `c` integer, `d` text NOT NULL DEFAULT '0', `e` real NOT NULL DEFAULT -1.5);"
const RETYPED = AFTER.replace("`c` integer", "`c` text")

describe("the classification of Atlas's rebuild copies", () => {
	it("rates a rebuild that fills new NOT NULL columns with their defaults cautious", async () => {
		const h = history(undefined, "")
		try {
			const earlier = extractSchema(readFileSync(await h.diff(BEFORE, "init"), "utf8"))
			const file = readFileSync(await h.diff(AFTER, "defaults"), "utf8")
			expect(file).toContain("IFNULL(`a`, (unixepoch() * 1000)) AS `a`")
			expect(file).toContain("IFNULL(`b`, (CURRENT_TIMESTAMP)) AS `b`")
			expect(classifyMigration(file, { before: earlier, dialect: "sqlite" })).toMatchObject({
				cautiousStatements: ["DROP TABLE `t` (rebuilds t, copying every column)"],
				safety: "cautious",
			})
		} finally {
			h.dispose()
		}
	}, 60_000)

	it("rates a rebuild that retypes a column to another affinity unsafe, naming the column (M5)", async () => {
		const h = history(undefined, "")
		try {
			const earlier = extractSchema(readFileSync(await h.diff(BEFORE, "init"), "utf8"))
			const file = readFileSync(await h.diff(RETYPED, "retype"), "utf8")
			expect(classifyMigration(file, { before: earlier, dialect: "sqlite" })).toMatchObject({
				safety: "unsafe",
				unsafeStatements: [
					"DROP TABLE `t` (rebuilds t: its new table changes c's affinity from INTEGER to TEXT, which can change its values)",
				],
			})
		} finally {
			h.dispose()
		}
	}, 60_000)
})
