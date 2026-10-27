/**
 * M84 of the 0.13.0 round: REPLICA IDENTITY NOTHING leaves a table with no replica identity, so
 * every later UPDATE and DELETE fails on a table a publication publishes them for, breaking
 * deployed code. Postgres 17 refuses a non-unique, nullable or partial index as a replica
 * identity on its own, so USING INDEX breaks nothing a later statement relies on.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

/** `later`'s rating after a history that made users, read as Postgres */
function rate(later: string) {
	const before = extractSchema("CREATE TABLE users (id int PRIMARY KEY, email text);", undefined, "postgres")
	return classifyMigration(later, { before, dialect: "postgres" })
}

/** `later`'s safety after `history`, both read as Postgres */
const after = (history: string, later: string) =>
	classifyMigration(later, { before: extractSchema(history, undefined, "postgres"), dialect: "postgres" }).safety

describe("a table's replica identity (M84)", () => {
	it("rates REPLICA IDENTITY NOTHING cautious, saying what it breaks", () => {
		const rated = rate("ALTER TABLE users REPLICA IDENTITY NOTHING;")
		expect(rated.safety).toBe("cautious")
		expect(rated.cautiousStatements.join(" ")).toContain(
			"UPDATE and DELETE fail on a table a publication publishes them for",
		)
	})

	it("leaves FULL, DEFAULT and USING INDEX safe", () => {
		for (const later of [
			"ALTER TABLE users REPLICA IDENTITY FULL;",
			"ALTER TABLE users REPLICA IDENTITY DEFAULT;",
			"ALTER TABLE users REPLICA IDENTITY USING INDEX users_pkey;",
		])
			expect([later, rate(later).safety]).toEqual([later, "safe"])
	})

	/* the other spellings that leave a table with no replica identity (probed on PG17), already rated, pinned */
	it("keeps a dropped identity index and a dropped primary key cautious, and a primary-key column's drop unsafe", () => {
		const identity =
			"CREATE TABLE t (id int NOT NULL, v text); CREATE UNIQUE INDEX t_id ON t (id); ALTER TABLE t REPLICA IDENTITY USING INDEX t_id;"
		const keyed = "CREATE TABLE t (id int PRIMARY KEY, v text);"
		expect(after(identity, "DROP INDEX t_id;")).toBe("cautious")
		expect(after(keyed, "ALTER TABLE t DROP CONSTRAINT t_pkey;")).toBe("cautious")
		expect(after(keyed, "ALTER TABLE t DROP COLUMN id CASCADE;")).toBe("unsafe")
	})
})
