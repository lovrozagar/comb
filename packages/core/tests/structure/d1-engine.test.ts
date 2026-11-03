/**
 * A pending D1 file is proven on D1's own engine, as wrangler sends it (SD1 and SD2 of r22b): through
 * the real wrangler peer and its local D1 (workerd), what D1's authorizer, limits or wrangler's own
 * rewrite would refuse is refused at check, before anything applies, and what D1 runs passes. The
 * wrangler peer is required: resolving it fails this file rather than skipping it.
 */
import fs from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../src/cli/index.ts"
import { d1Column, d1Io, d1Project, writeMigrations } from "../integration/support/d1-project.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

const SEED = {
	"0000_seed.sql":
		"CREATE TABLE t (id INTEGER PRIMARY KEY, v REAL NOT NULL DEFAULT 1);\nINSERT INTO t (v) VALUES (2), (3);\n",
}

/** A local D1 with the seed applied and `file` pending; check's code and lines on it */
async function checked(file: string): Promise<{ code: number; dir: string; text: string }> {
	const dir = d1Project(SEED)
	dirs.push(dir)
	const seed = d1Io(dir)
	expect(await runCli(["migrate", "apply", "core", "--local"], seed), seed.errors.join("\n")).toBe(0)
	writeMigrations(dir, { "0001_case.sql": file })
	const check = d1Io(dir)
	const code = await runCli(["migrate", "check", "core", "--local", "--yes"], check)
	return { code, dir, text: [...check.outputs, ...check.errors].join("\n") }
}

describe("a D1 file is proven on D1's own engine (SD1 of r22b; sibling: S1's pinned-sqld set)", () => {
	it.each([
		[
			"a trigger whose body calls a function D1 does not authorize",
			"-- comb:allow-unsafe: keep a squared copy\nCREATE TABLE sq (id INTEGER PRIMARY KEY, v REAL);\nCREATE TRIGGER t_sq AFTER INSERT ON t BEGIN INSERT INTO sq (id, v) VALUES (new.id, power(new.v, 2)); END;\n",
			/not authorized to use function: power/,
		],
		[
			"a view over a function D1 lacks",
			"CREATE VIEW stats AS SELECT median(v) AS med FROM t;\n",
			/no such function: median/,
		],
		[
			"a generated column over a function D1 does not authorize",
			"CREATE TABLE g (id INTEGER PRIMARY KEY, v REAL, up REAL GENERATED ALWAYS AS (ceiling(v)) VIRTUAL);\n",
			/not authorized to use function: ceiling/,
		],
		[
			"a backfill calling power()",
			"ALTER TABLE t ADD COLUMN sq REAL;\nUPDATE t SET sq = power(v, 2);\n",
			/not authorized to use function: power/,
		],
	])(
		"refuses %s at check, naming D1's error, and applies nothing",
		async (_, file, error) => {
			const { code, dir, text } = await checked(file)
			expect(code, text).toBe(1)
			expect(text).toMatch(error)
			expect(d1Column(dir, "SELECT name FROM d1_migrations")).toEqual(["0000_seed.sql"])
		},
		180_000,
	)

	it.each([
		["an rtree table", "CREATE VIRTUAL TABLE box USING rtree (id, x0, x1);\n"],
		[
			"PRAGMA optimize with a mask",
			"-- comb:allow-unsafe: refresh the planner's statistics\nCREATE INDEX t_v ON t (v);\nPRAGMA optimize(65538);\n",
		],
	])(
		"passes %s, which D1 runs",
		async (_, file) => {
			const { code, text } = await checked(file)
			expect(code, text).toBe(0)
			expect(text).toMatch(/Check passed: 1 pending: 0001_case\.sql/)
		},
		180_000,
	)
})

describe("the proof runs the text wrangler runs (SD2 of r22b; sibling: SL2's split)", () => {
	it("refuses a literal wrangler --local would rewrite, naming the literal and wrangler's rewrite", async () => {
		const { code, text } = await checked(
			"CREATE TABLE help (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\nINSERT INTO help (id, body) VALUES (1, 'Batch writes: BEGIN TRANSACTION; UPDATE ...; COMMIT;');\n",
		)
		expect(code, text).toBe(1)
		expect(text).toMatch(/'Batch writes: BEGIN TRANSACTION; UPDATE \.\.\.; COMMIT;'/)
		expect(text).toMatch(/wrangler/)
		expect(text).toMatch(/'BEGIN ' \|\| 'TRANSACTION'/)
	}, 180_000)
})
