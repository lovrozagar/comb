/**
 * The classification of Atlas's own rebuild copies, on the real Atlas: a column made NOT NULL with
 * a default comes back as `IFNULL(<column>, <its new default>)`, which keeps every row, so the
 * rebuild rates cautious.
 */
import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { describeAtlas } from "../support/atlas.ts"
import { history } from "../support/rebuild-guard.ts"

const BEFORE = "CREATE TABLE `t` (`id` text PRIMARY KEY, `a` integer, `b` text, `c` integer, `d` text, `e` real);"
const AFTER =
	"CREATE TABLE `t` (`id` text PRIMARY KEY, `a` integer NOT NULL DEFAULT (unixepoch() * 1000), `b` text NOT NULL DEFAULT CURRENT_TIMESTAMP, `c` text, `d` integer NOT NULL DEFAULT 0, `e` real NOT NULL DEFAULT -1.5);"

describeAtlas("the classification of Atlas's rebuild copies", () => {
	it("rates a rebuild that fills new NOT NULL columns with their defaults cautious", () => {
		const h = history(undefined, "")
		try {
			const earlier = extractSchema(readFileSync(h.diff(BEFORE, "init"), "utf8"))
			const file = readFileSync(h.diff(AFTER, "defaults"), "utf8")
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
})
