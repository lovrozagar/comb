/**
 * readPending (atlas-pending.ts): each pending file of a Postgres snapshot read once and
 * classified against the schema the files before it leave, keyed under the target's schema, and a
 * file that cannot run refused from the file alone, before anything replays it (PA2 of r22b); and
 * where the target's catalog places its relations taken where the applied files end (PA17 of r22b,
 * 16.3 c of plan 21), which a relation a pending file makes again does not keep
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { readPending } from "./atlas-pending.ts"
import type { Placed } from "./pg-storage-types.ts"
import { loadPostgresParser } from "./pg-parser.ts"

beforeAll(loadPostgresParser)

let copy = ""
beforeEach(() => {
	copy = mkdtempSync(join(tmpdir(), "comb-atlas-pending-"))
})
afterEach(() => rmSync(copy, { force: true, recursive: true }))

/** The snapshot's files, named 1_a.sql, 2_b.sql… in order */
function write(files: readonly string[]): void {
	files.forEach((sql, i) => writeFileSync(join(copy, `${i + 1}_${String.fromCharCode(97 + i)}.sql`), sql))
}

/** The pending `names` of the snapshot classified for a target in `schema` */
const classify = (names: readonly string[], schema = "public") =>
	readPending({ target: { schema } }, copy, new Set(names)).classify({})

describe("readPending", () => {
	it("classifies the pending files alone, in order, each against the schema the files before it leave", () => {
		write([
			"CREATE TABLE a (id int);\n",
			"CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\nCREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();\n",
			"INSERT INTO a VALUES (1);\n",
		])
		const migrations = classify(["2_b.sql", "3_c.sql"])
		expect(migrations.map((migration) => migration.filename)).toEqual(["2_b.sql", "3_c.sql"])
		/* the pending file before it made the trigger its insert fires */
		expect(migrations[1]?.classification.unsafeStatements).toEqual([
			"INSERT INTO a VALUES (1) (fires trigger t, whose body runs for every row it writes)",
		])
	})

	it("rates a pending file alone once nothing before it holds what it writes to", () => {
		write(["CREATE TABLE a (id int);\n", "INSERT INTO a VALUES (1);\n"])
		expect(classify(["2_b.sql"])[0]?.classification.safety).toBe("safe")
	})

	it("keys the names under the target's schema, as its search_path resolves them", () => {
		write(["CREATE TABLE a (id int);\n", "UPDATE public.a SET id = 2;\n"])
		expect(
			["public", "app"].map((schema) => classify(["2_b.sql"], schema)[0]?.classification.unsafeStatements),
		).toEqual([
			["UPDATE public.a SET id = 2 (updates existing rows of a (id))"],
			["UPDATE public.a SET id = 2 (updates existing rows of public.a (id))"],
		])
	})

	it("refuses a pending file that cannot run from the file alone, whatever it approves (PA2)", () => {
		write(["-- comb:allow-unsafe: commits as it goes\nCREATE TABLE a (id int);\nCOMMIT;\n"])
		expect(() => classify(["1_a.sql"])).toThrow(
			"COMMIT: Atlas runs this file in one transaction and records it there, so its own COMMIT ends that transaction",
		)
	})

	it("refuses a pending file after an earlier file Postgres's parser cannot read, naming that file (M75)", () => {
		write(["CREATE TABL a (id int);\n", "CREATE TABLE b (id int);\n"])
		expect(() => classify(["2_b.sql"])).toThrow(
			'comb could not read 1_a.sql: "CREATE TABL a (id int)" (syntax error at or near "TABL")',
		)
	})

	it("refuses a file Atlas cannot split, by name, with Atlas's reason", () => {
		write(["SELECT (1;\n"])
		expect(() => classify(["1_a.sql"])).toThrow(
			"comb could not read 1_a.sql: Atlas cannot split this file: 1:8: unclosed '('",
		)
	})
})

/* the target's catalog after 1_a.sql: a and its index a_id where Postgres's defaults put them */
const PLACED: Placed = {
	indexes: new Map([["a_id", "pg_default"]]),
	relations: new Map([["a", { accessMethod: "heap", logged: true, tablespace: "pg_default" }]]),
}

/** The lock warnings of the pending `names`, with the target's relations where `placed` says, and whether one moves a relation */
function placedWarnings(names: readonly string[], placed?: Placed): { moves: boolean; warned: string[][] } {
	const { classify: rated, moves } = readPending({ target: { schema: "public" } }, copy, new Set(names))
	return { moves, warned: rated({ placed }).map(({ classification }) => classification.lockWarnings) }
}

describe("readPending's moves (PA17 of r22b, 16.3 c)", () => {
	const MADE = "CREATE TABLE a (id int);\nCREATE INDEX a_id ON a (id);\n"
	const STAY =
		"ALTER TABLE a SET ACCESS METHOD heap, SET TABLESPACE pg_default;\nALTER INDEX a_id SET TABLESPACE pg_default;\n"

	it("warns of nothing for a move to where the target's catalog says it is, once the applied files end", () => {
		write([MADE, STAY])
		expect(placedWarnings(["2_b.sql"], PLACED)).toEqual({ moves: true, warned: [[]] })
	})

	it("warns of each move it cannot place: without the catalog, and of a relation a pending file made again", () => {
		write([MADE, STAY])
		expect(placedWarnings(["2_b.sql"]).warned[0]).toHaveLength(2)
		write([MADE, `DROP TABLE a;\n${MADE}`, STAY])
		expect(placedWarnings(["2_b.sql", "3_c.sql"], PLACED).warned[1]).toHaveLength(2)
	})

	it("says no pending file moves a relation for a SET LOGGED, whose no-op the history alone reads", () => {
		write([MADE, "ALTER TABLE a SET LOGGED;\n"])
		expect(placedWarnings(["2_b.sql"], PLACED)).toEqual({ moves: false, warned: [[]] })
	})
})
