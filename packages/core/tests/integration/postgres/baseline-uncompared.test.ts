/**
 * P12 of r19: what a baseline does not compare it names, every run, and nothing else is left out. Each case
 * is a history that makes X over a target built by the same files without X: a kind the catalog read compares
 * refuses the baseline, naming X; a kind it does not compare baselines, and the warning names X's kind.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { baselineWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-baseline-uncompared-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** Run `sql` on the database at `url` */
async function exec(url: string, sql: string): Promise<void> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		await client.query(sql)
	} finally {
		await client.end()
	}
}

/** A target built by `target`, baselined against `history`: what it printed, or why it refused */
async function baselineOf(target: string, history: string): Promise<{ out: string[]; refused?: string | undefined }> {
	writeFileSync(join(dir, "20260101000000_init.sql"), history)
	hashDir(run, dir)
	return withScratchDb((dev) =>
		withScratchDb(async (url) => {
			if (target !== "") await exec(url, target)
			const out: string[] = []
			try {
				await baselineWithAtlas({
					dir,
					print: (line) => out.push(line),
					target: { devUrl: dev, lockTimeout: "5s", schema: "public", url },
				})
				return { out }
			} catch (error) {
				return { out, refused: (error as Error).message }
			}
		}),
	)
}

const T = "CREATE TABLE t (id int PRIMARY KEY, v int);\n"
const FN = "CREATE FUNCTION f(int) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT $1';\n"
const TF = "CREATE FUNCTION tf() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;\n"
const ADD2 = "CREATE FUNCTION add2(int, int) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT $1 + $2';\n"

describe("a Postgres baseline over a target lacking a kind the catalog read now compares (P12 of r19)", () => {
	it.each([
		[
			"a materialized view's index",
			`${T}CREATE MATERIALIZED VIEW m AS SELECT id FROM t;\n`,
			"CREATE UNIQUE INDEX m_id ON m (id);\n",
			/index m_id on m/,
		],
		["an operator", `${T}${FN}`, "CREATE OPERATOR @@@ (RIGHTARG = int, FUNCTION = f);\n", /operator @@@/],
		[
			"a cast",
			"CREATE TYPE pair AS (a int, b int);\nCREATE FUNCTION pi(pair) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT 1';\n",
			"CREATE CAST (pair AS int) WITH FUNCTION pi(pair);\n",
			/cast \(pair as int4\)/,
		],
		[
			"an event trigger",
			"CREATE FUNCTION et() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$;\n",
			"CREATE EVENT TRIGGER comb_p12_e ON ddl_command_start EXECUTE FUNCTION et();\n",
			/event trigger comb_p12_e/,
		],
		["a publication", T, "CREATE PUBLICATION comb_p12_pub FOR TABLE t;\n", /publication comb_p12_pub/],
		["an aggregate", ADD2, "CREATE AGGREGATE mysum(int) (SFUNC = add2, STYPE = int);\n", /aggregate mysum\(int4\)/],
		[
			"a function's SECURITY DEFINER",
			FN,
			"ALTER FUNCTION f(int) SECURITY DEFINER;\n",
			/function f\(int4\) .*security definer/,
		],
		[
			"a view's security_invoker",
			`${T}CREATE VIEW v AS SELECT id FROM t;\n`,
			"ALTER VIEW v SET (security_invoker = true);\n",
			/view v \(security_invoker=true\)/,
		],
		["a table's REPLICA IDENTITY FULL", T, "ALTER TABLE t REPLICA IDENTITY FULL;\n", /replica identity on t \(full\)/],
		/* Atlas's own table diff compares these two, which the warning therefore does not name */
		[
			"an enum's value",
			`${T}CREATE TYPE mood AS ENUM ('a');\nCREATE TABLE m (x mood);\n`,
			"ALTER TYPE mood ADD VALUE 'b';\n",
			/ADD VALUE 'b'/,
		],
		["a table's storage parameter", T, "ALTER TABLE t SET (fillfactor = 70);\n", /fillfactor = 70/],
	])("refuses a target lacking %s, naming it", async (...[, base, extra, named]) => {
		const { refused } = await baselineOf(base, `${base}${extra}`)
		expect(refused).toMatch(named)
	})
})

describe("a Postgres baseline over a target lacking a kind it does not compare (P12 of r19)", () => {
	const TRIGGER = "CREATE TRIGGER tr BEFORE UPDATE ON t FOR EACH ROW"
	it.each([
		[
			"a trigger's WHEN clause",
			`${T}${TF}${TRIGGER} EXECUTE FUNCTION tf();\n`,
			`${T}${TF}${TRIGGER} WHEN (OLD.v IS DISTINCT FROM NEW.v) EXECUTE FUNCTION tf();\n`,
			"triggers' WHEN clauses",
		],
		[
			"a view column's default",
			`${T}CREATE VIEW v AS SELECT id, v FROM t;\n`,
			`${T}CREATE VIEW v AS SELECT id, v FROM t;\nALTER VIEW v ALTER COLUMN v SET DEFAULT 5;\n`,
			"view columns' defaults",
		],
		[
			"a column's statistics target",
			T,
			`${T}ALTER TABLE t ALTER COLUMN v SET STATISTICS 500;\n`,
			"columns' statistics targets",
		],
		[
			"a text search configuration",
			"",
			"CREATE TEXT SEARCH CONFIGURATION comb_p12_ts (COPY = english);\n",
			"text search configurations",
		],
	])("baselines a target lacking %s, and names its kind in the warning", async (...[, target, history, kind]) => {
		const { out, refused } = await baselineOf(target, history)
		expect(refused).toBeUndefined()
		expect(out.join("\n")).toContain(kind)
	})
})
