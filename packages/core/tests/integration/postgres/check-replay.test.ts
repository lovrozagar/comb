/**
 * P13 of r19: a retype of a column a view reads passed check, then failed on every apply, because
 * Postgres refuses it ("cannot alter type of a column used by a view or rule"). Check now replays the
 * history and the pending files on a postgres:// devUrl in one transaction it rolls back, so Postgres
 * decides: each kind of dependent its probe found refusing the retype stops check with Postgres's
 * message, each it found allowing it passes, and a statement only `-- atlas:txmode none` can run is
 * left out of the replay and named.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-check-replay-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** A scratch database held from the file's first test to its last: its URL, inside a test */
function heldScratchDb(): () => string {
	const held = { release: () => undefined as void, url: "" }
	let dropped: Promise<void> = Promise.resolve()
	beforeAll(
		() =>
			new Promise<void>((ready) => {
				dropped = withScratchDb(
					(url) =>
						new Promise<void>((release) => {
							Object.assign(held, { release, url })
							ready()
						}),
				)
			}),
	)
	afterAll(async () => {
		held.release()
		await dropped
	})
	return () => held.url
}

/* one dev and one target for every check: the replay rolls back on dev, and a check of a target with no history writes nothing */
const devUrl = heldScratchDb()
const targetUrl = heldScratchDb()

const T =
	"CREATE TABLE t (id int PRIMARY KEY, v varchar(10), w int);\nCREATE TABLE u (id int PRIMARY KEY, v varchar(10));\n"
const RETYPE = "ALTER TABLE t ALTER COLUMN v TYPE varchar(20);\n"

/** The options a check of the directory against `target` takes, collecting what it prints in `out` */
const options = (target: { devUrl: string; url: string }, out: string[]) => ({
	approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
	dir,
	print: (line: string) => out.push(line),
	target: { ...target, lockTimeout: "5s", schema: "public" },
})

/** `one` then `two`, written and hashed: a history of `one` with `two` pending, as check replays them */
function files(one: string, two: string): void {
	/* CREATE STATISTICS is a kind comb does not rate: the history's own approval lets it pass */
	writeFileSync(join(dir, "20260101000000_one.sql"), `-- comb:allow-unsafe: the test's history\n${one}`)
	writeFileSync(join(dir, "20260102000000_two.sql"), two)
	hashDir(run, dir)
}

/** `one` then `two` checked on the shared target: what check printed, or why it refused */
async function checked(one: string, two: string): Promise<{ out: string[]; refused?: string | undefined }> {
	files(one, two)
	const out: string[] = []
	try {
		await applyWithAtlas({ ...options({ devUrl: devUrl(), url: targetUrl() }, out), checkOnly: true })
		return { out }
	} catch (error) {
		return { out, refused: (error as Error).message }
	}
}

describe("check of a retype Postgres refuses on every database (P13 of r19)", () => {
	it.each([
		["a view", "CREATE VIEW x AS SELECT v FROM t;\n", "used by a view or rule"],
		["a view through t.*", "CREATE VIEW x AS SELECT * FROM t;\n", "used by a view or rule"],
		[
			"a view through an alias in a join",
			"CREATE VIEW x AS SELECT a.v FROM t a JOIN u b ON a.id = b.id;\n",
			"used by a view or rule",
		],
		["a materialized view", "CREATE MATERIALIZED VIEW x AS SELECT v FROM t;\n", "used by a view or rule"],
		[
			"a rule",
			"CREATE TABLE l (v text);\nCREATE RULE r AS ON UPDATE TO t DO ALSO INSERT INTO l VALUES (NEW.v);\n",
			"used by a view or rule",
		],
		["a policy", "CREATE POLICY p ON t USING (v <> '');\n", "used in a policy definition"],
		[
			"a trigger's WHEN",
			"CREATE FUNCTION tf() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;\nCREATE TRIGGER tr BEFORE UPDATE ON t FOR EACH ROW WHEN (NEW.v <> '') EXECUTE FUNCTION tf();\n",
			"used in a trigger definition",
		],
		[
			"a generated column",
			"ALTER TABLE t ADD COLUMN g text GENERATED ALWAYS AS (v || 'x') STORED;\n",
			"used by a generated column",
		],
		[
			"a BEGIN ATOMIC function",
			"CREATE FUNCTION n() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(v) FROM t; END;\n",
			"used by a function or procedure",
		],
	])("refuses one of a column %s reads, with Postgres's own message", async (_, dependent, said) => {
		const { refused } = await checked(`${T}${dependent}`, RETYPE)
		expect(refused).toContain(
			`20260102000000_two.sql: devUrl refused "ALTER TABLE t ALTER COLUMN v TYPE varchar(20)" as check replayed the history and the pending files there: cannot alter type of a column ${said}`,
		)
		expect(refused).toMatch(/; check applies nothing$/)
	})

	it.each([
		["a CHECK constraint", "ALTER TABLE t ADD CONSTRAINT c CHECK (v <> '');\n"],
		["an index expression", "CREATE INDEX i ON t (lower(v));\n"],
		["a statistics object", "CREATE STATISTICS s ON v, w FROM t;\n"],
		["a view of another table's column of that name", "CREATE VIEW x AS SELECT u.v FROM t JOIN u USING (id);\n"],
	])("passes one of a column %s reads, which Postgres retypes", async (_, dependent) => {
		const { out, refused } = await checked(`${T}${dependent}`, RETYPE)
		expect(refused).toBeUndefined()
		expect(out.join("\n")).not.toContain("Check did not replay")
	})
})

describe("check of a pending retype over a history the target has applied", () => {
	it("replays the applied history before the pending file, and refuses the retype a view blocks", async () => {
		await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				files(`${T}CREATE VIEW x AS SELECT v FROM t;\n`, RETYPE)
				rmSync(join(dir, "20260102000000_two.sql"))
				hashDir(run, dir)
				const out: string[] = []
				await applyWithAtlas(options({ devUrl: dev, url }, out))
				files(`${T}CREATE VIEW x AS SELECT v FROM t;\n`, RETYPE)
				await expect(applyWithAtlas({ ...options({ devUrl: dev, url }, out), checkOnly: true })).rejects.toThrow(
					/20260102000000_two\.sql: devUrl refused .* cannot alter type of a column used by a view or rule/,
				)
			}),
		)
	}, 60_000)
})

describe("check's replay of a statement only a file of its own can run", () => {
	it("replays a CONCURRENTLY detach without the keyword, and passes it", async () => {
		const one =
			"CREATE TABLE ev (id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE ev_def PARTITION OF ev DEFAULT;\n"
		const { out, refused } = await checked(
			one,
			"-- atlas:txmode none\n\nALTER TABLE ev DETACH PARTITION ev_def CONCURRENTLY;\n",
		)
		expect(refused).toBeUndefined()
		expect(out.join("\n")).not.toContain("Check left")
	})
})
