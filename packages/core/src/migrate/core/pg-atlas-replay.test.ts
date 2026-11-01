import { beforeAll, describe, expect, it } from "vitest"
import { extensionReplay, viewReplay } from "./pg-atlas-replay.ts"
import { separatePgObjects } from "./pg-objects.ts"
import { loadPostgresParser } from "./pg-parser.ts"

beforeAll(loadPostgresParser)

/* P4 of r19: a view replays where it stands, in a DO block, so what depends on it replays after it */
describe("viewReplay", () => {
	it.each([
		[
			"CREATE VIEW v AS SELECT 1",
			"DO $comb$ BEGIN EXECUTE $comb_view$CREATE VIEW v AS SELECT 1$comb_view$; END $comb$",
		],
		[
			"CREATE OR REPLACE MATERIALIZED VIEW m AS SELECT 1",
			"DO $comb$ BEGIN EXECUTE $comb_view$CREATE OR REPLACE MATERIALIZED VIEW m AS SELECT 1$comb_view$; END $comb$",
		],
		[
			"DROP MATERIALIZED VIEW IF EXISTS m",
			"DO $comb$ BEGIN EXECUTE $comb_view$DROP MATERIALIZED VIEW IF EXISTS m$comb_view$; END $comb$",
		],
		[
			"CREATE VIEW v AS SELECT $comb_view$x$comb_view$ AS s",
			"DO $comb$ BEGIN EXECUTE $comb_view1$CREATE VIEW v AS SELECT $comb_view$x$comb_view$ AS s$comb_view1$; END $comb$",
		],
	])("hands %j over in a DO block, under a dollar tag it does not hold", (sql, want) => {
		expect(viewReplay(sql, sql)).toBe(want)
	})

	it("leaves every other statement to the replay as it is", () => {
		expect(viewReplay("CREATE TABLE t (id int)", "CREATE TABLE t (id int)")).toBeUndefined()
		expect(
			separatePgObjects(
				"CREATE TABLE t (id int);\nCREATE VIEW v AS SELECT id FROM t;\nCREATE POLICY p ON t USING (true);",
			).replay,
		).toEqual([
			"CREATE TABLE t (id int)",
			"DO $comb$ BEGIN EXECUTE $comb_view$CREATE VIEW v AS SELECT id FROM t$comb_view$; END $comb$",
		])
	})
})

describe("extensionReplay", () => {
	it("hands an extension's create and drop over in a DO block, and leaves anything else", () => {
		expect(extensionReplay("CREATE EXTENSION pg_trgm", "CREATE EXTENSION pg_trgm")).toBe(
			"DO $comb$ BEGIN EXECUTE $comb_view$CREATE EXTENSION pg_trgm$comb_view$; END $comb$",
		)
		expect(extensionReplay("DROP EXTENSION pg_trgm CASCADE", "DROP EXTENSION pg_trgm CASCADE")).toMatch(/^DO \$comb\$/)
		expect(extensionReplay("CREATE VIEW v AS SELECT 1", "CREATE VIEW v AS SELECT 1")).toBeUndefined()
	})
})
