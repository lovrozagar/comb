/**
 * PA3n of r22b: Atlas reads a file's leading `-- atlas:` line as a directive only in a header a
 * blank line closes; without one it reads the line as a comment and runs the file in one
 * transaction. comb refuses such a file on every dialect, naming the file and the line, as the
 * stale libsql fixture (3e61144d) showed a writer misses it.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { CYCLE_BASE, CYCLE_REBUILD } from "../../../tests/integration/support/cycle-guard.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { extractSchema, parseMigration } from "./parse.ts"
import { guardRebuilds } from "./rebuild-guard.ts"

beforeAll(loadPostgresParser)

const NAME = "20260102000000_rebuild.sql"
const MISREAD = `${NAME} line 1: Atlas reads "-- atlas:txmode none" as a comment, since no blank line closes the comments the file opens with, and runs the file in a transaction; add a blank line after the line, or remove it`

describe("a leading atlas: line no blank line closes (PA3n of r22b)", () => {
	it("refuses the stale libsql fixture's file, naming the file and the line", () => {
		const guarded = guardRebuilds(CYCLE_REBUILD, extractSchema(CYCLE_BASE))
		expect(() =>
			parseMigration(`-- atlas:txmode none\n${guarded}`, NAME, {
				before: extractSchema(CYCLE_BASE),
				dialect: "sqlite",
			}),
		).toThrow(MISREAD)
	})

	it("refuses one on Postgres", () => {
		expect(() =>
			parseMigration("-- atlas:txmode none\nCREATE INDEX CONCURRENTLY t_x ON t (x);\n", NAME, {
				before: extractSchema("CREATE TABLE t (x int);", undefined, "postgres"),
				dialect: "postgres",
			}),
		).toThrow(MISREAD)
	})

	it("names the first directive past a comment line", () => {
		expect(() => parseMigration("-- why\n-- atlas:nolint\nCREATE TABLE t (x int);\n", NAME)).toThrow(
			`${NAME} line 2: Atlas reads "-- atlas:nolint" as a comment`,
		)
	})

	it.each([
		["a blank line after it", "-- atlas:txmode none\n\nCREATE TABLE t (x int);\n"],
		["a first-line delimiter, which Atlas honors where it stands", "-- atlas:delimiter $$\nCREATE TABLE t (x int)$$\n"],
		["comments with no directive", "-- why\nCREATE TABLE t (x int);\n"],
	])("passes a file with %s", (_, sql) => {
		expect(parseMigration(sql, NAME).filename).toBe(NAME)
	})
})
