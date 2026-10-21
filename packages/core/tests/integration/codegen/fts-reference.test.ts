/**
 * The FTS reference SQL codegen writes, applied by hand as its header says: written again after
 * a column change, it replaces the index and its triggers and rebuilds the index from its content.
 */
import { describe, expect, it } from "vitest"
import type { TableMeta } from "../../../src/codegen/analyzer-types.ts"
import { ftsReferenceSql } from "../../../src/codegen/generators/fts-sql.ts"
import { libsqlMemory } from "../support/libsql.ts"

const field = (name: string) =>
	({ constraints: {}, drizzleHelper: "text", isNotNull: false, name, raw: `c.text("${name}")`, sqlName: name }) as never
const post = { fields: [field("title"), field("author")], sqlName: "post", varName: "post" } as unknown as TableMeta

describe("the FTS reference SQL applied after a column change (F11)", () => {
	it("replaces the index and its triggers and rebuilds it, finding rows by the new column", async () => {
		const { client, close } = libsqlMemory()
		try {
			await client.executeMultiple(
				"CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT, author TEXT); INSERT INTO post (title, author) VALUES ('hello', 'ada');",
			)
			await client.executeMultiple(ftsReferenceSql([post], { post: { columns: ["title"] } }, () => undefined))
			await client.executeMultiple(ftsReferenceSql([post], { post: { columns: ["title", "author"] } }, () => undefined))
			const columns = await client.execute("SELECT name FROM pragma_table_info('post_fts') ORDER BY cid")
			expect(columns.rows.map((row) => row[0])).toEqual(["title", "author"])
			expect((await client.execute("SELECT rowid FROM post_fts WHERE post_fts MATCH 'ada'")).rows).toHaveLength(1)
			await client.execute("INSERT INTO post (title, author) VALUES ('bye', 'cy')")
			expect((await client.execute("SELECT rowid FROM post_fts WHERE post_fts MATCH 'cy'")).rows).toHaveLength(1)
		} finally {
			close()
		}
	})
})
