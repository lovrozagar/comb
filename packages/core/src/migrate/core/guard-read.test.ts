import { describe, expect, it } from "vitest"
import { readGuards } from "./guard-read.ts"
import { guardRebuilds } from "./rebuild-guard.ts"
import { extractSchema } from "./schema.ts"
import { codeOf } from "./sql-code.ts"
import { splitSqlStatements } from "./sql-scan.ts"

const BEFORE = extractSchema(`CREATE TABLE u (id integer PRIMARY KEY, name text);
CREATE TABLE post (id integer PRIMARY KEY, author integer REFERENCES u (id) ON DELETE CASCADE);`)
const REBUILD = `CREATE TABLE \`new_u\` (\`id\` integer NOT NULL, \`name\` text, PRIMARY KEY (\`id\`));
INSERT INTO \`new_u\` (\`id\`, \`name\`) SELECT \`id\`, \`name\` FROM \`u\`;
DROP TABLE \`u\`;
ALTER TABLE \`new_u\` RENAME TO \`u\`;
`

/** What readGuards makes of `sql` against `before` */
function read(sql: string, before = BEFORE) {
	const statements = splitSqlStatements(sql)
	return readGuards(
		statements,
		statements.map((stmt) => codeOf(stmt, "sqlite")),
		before,
	)
}

describe("readGuards", () => {
	it("reads comb's guard: the statements it is, and the rows it keeps", () => {
		const guards = read(guardRebuilds(REBUILD, BEFORE))
		expect(guards.kept).toEqual(new Map([["u", ["post"]]]))
		expect(guards.guarded.size).toBeGreaterThan(0)
		expect(guards.fired).toEqual(new Map())
	})

	/* M24 of the 0.13 review */
	it("names the trigger a guard would fire on a table it empties, a trigger a later file made, an FTS sync aside", () => {
		const later = extractSchema("CREATE TRIGGER post_gone AFTER DELETE ON post BEGIN SELECT 1; END;", BEFORE)
		expect(read(guardRebuilds(REBUILD, BEFORE), later).fired).toEqual(
			new Map([
				[
					"u",
					"empties and refills post, which fires its trigger post_gone; drop the trigger first, or change u by hand",
				],
			]),
		)
		const synced = extractSchema(
			"CREATE VIRTUAL TABLE post_fts USING fts5(author, content='post', content_rowid='id');\nCREATE TRIGGER post_fts_ad AFTER DELETE ON post BEGIN INSERT INTO post_fts(post_fts, rowid, author) VALUES ('delete', old.id, old.author); END;",
			BEFORE,
		)
		expect(read(guardRebuilds(REBUILD, BEFORE), synced).fired).toEqual(new Map())
	})

	it("reads nothing without the earlier schema", () => {
		const statements = splitSqlStatements(guardRebuilds(REBUILD, BEFORE))
		const codes = statements.map((stmt) => codeOf(stmt, "sqlite"))
		expect(readGuards(statements, codes, undefined).guarded.size).toBe(0)
	})
})
