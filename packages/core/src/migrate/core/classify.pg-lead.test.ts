/**
 * N1 of plan 15's rerun: Atlas sends a chunk's text without its lead, so a statement behind a lead
 * Postgres would read otherwise, a nested block comment, is rated by what runs, with a real reason,
 * and the schema it makes is followed. Its lead stays on the text a file written back keeps.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { pgRead } from "./pg-split.ts"
import { extractSchema } from "./schema.ts"

beforeAll(() => loadPostgresParser())

describe("a Postgres statement behind a nested leading comment", () => {
	it("is rated by the statement Atlas sends: a SELECT is safe, a DELETE unsafe and named", () => {
		expect(classifyMigration("/* a /* b */ SELECT 1;", { dialect: "postgres" }).safety).toBe("safe")
		const deleted = classifyMigration("CREATE TABLE users (id int);\n/* a /* b */ DELETE FROM users;", {
			dialect: "postgres",
		})
		expect(deleted.safety).toBe("unsafe")
		expect(deleted.unsafeStatements.join(" ")).toContain("DELETE FROM users")
		expect(deleted.unsafeStatements.join(" ")).not.toContain("does not recognize ;")
	})

	it("makes the table it creates known to what follows, and keeps its lead on the text a file is written from", () => {
		const schema = extractSchema("/* a /* b */ CREATE TABLE t (id int);", undefined, "postgres")
		expect([...schema.tables.keys()]).toContain("t")
		const [statement] = pgRead("/* a /* b */ CREATE TABLE t (id int);").statements
		expect(statement?.sent).toBe("CREATE TABLE t (id int)")
		expect(statement?.text).toBe("/* a /* b */\nCREATE TABLE t (id int)")
	})
})
