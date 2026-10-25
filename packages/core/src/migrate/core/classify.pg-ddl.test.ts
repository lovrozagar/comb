/**
 * M70 of the 0.13.0 round: Postgres DDL is rated from the parse tree, as its writes are, so no
 * spelling the parser accepts (a quoted name with no space after it, an inheritance star, a
 * Unicode-escaped name) hides a dropped column, a retype, a rename or a drop, and every table and
 * column is keyed as the parser names it.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration, extractDropStatements } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const HISTORY = `CREATE TABLE users (id int PRIMARY KEY, email text);
CREATE TYPE status AS ENUM ('active', 'gone'); CREATE TABLE acct (id int, s status);
CREATE VIEW v AS SELECT id FROM users;`

/** `later`'s rating after HISTORY (or `history`), both read as Postgres */
function rate(later: string, history = HISTORY) {
	const before = extractSchema(history, undefined, "postgres")
	return classifyMigration(later, { before, dialect: "postgres" })
}

describe("Postgres DDL, rated from its parse tree (M70)", () => {
	it("rates a dropped column, a retype and SET NOT NULL unsafe in every spelling", () => {
		for (const later of [
			'ALTER TABLE "users"DROP COLUMN email;',
			"ALTER TABLE users* DROP COLUMN email;",
			'ALTER TABLE U&"\\0075sers" DROP COLUMN email;',
			'ALTER TABLE IF EXISTS"users" DROP COLUMN email;',
			'ALTER TABLE U&"\\0075sers" ALTER COLUMN email TYPE int USING NULL;',
			'ALTER TABLE "users"ALTER COLUMN email TYPE text USING NULL;',
			'ALTER TABLE "users"ALTER COLUMN email SET NOT NULL;',
		])
			expect(rate(later).safety, later).toBe("unsafe")
	})

	it("rates a table, view or enum value renamed unsafe in every spelling", () => {
		for (const later of [
			'ALTER TABLE "users"RENAME TO members;',
			'ALTER VIEW "v"RENAME TO v2;',
			`ALTER TYPE "status"RENAME VALUE 'active' TO 'enabled';`,
			'ALTER TABLE "users"SET SCHEMA archive;',
		])
			expect(rate(later).safety, later).toBe("unsafe")
	})

	it("names each drop as the parser reads its names", () => {
		expect(extractDropStatements('DROP TABLE U&"\\0075sers";', { dialect: "postgres" })).toEqual(["DROP TABLE users"])
		expect(extractDropStatements('ALTER TABLE users DROP COLUMN U&"\\0065mail";', { dialect: "postgres" })).toEqual([
			"DROP COLUMN users.email",
		])
		expect(extractDropStatements('DROP TABLE a, U&"\\0062";', { dialect: "postgres" })).toEqual([
			"DROP TABLE a",
			"DROP TABLE b",
		])
	})

	it("keys a fresh table as the parser names it, so it never stands for another", () => {
		const history = `${HISTORY} SELECT 1 AS id, 'keep'::text AS v INTO u;`
		expect(rate('CREATE TABLE U&"\\0061" (id int); UPDATE u SET v = NULL;', history).safety).toBe("unsafe")
	})

	it("keys an added column as the parser folds it, so its backfill is one", () => {
		const result = rate("ALTER TABLE users ADD COLUMN Note text; UPDATE users SET note = 'x';")
		expect(result.safety).toBe("cautious")
	})
})
