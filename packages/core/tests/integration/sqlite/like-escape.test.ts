import type { SQL } from "drizzle-orm"
import { SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { parseFilter } from "../../../src/query/filter.ts"
import { globPattern, likePattern } from "../../../src/query/like.ts"
import { conditionToSQL } from "../../../src/query/sqlite/executor.ts"
import { likeSearch, searchText } from "../../../src/query/sqlite/search.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"

const item = sqliteTable("item", {
	name: text("name").notNull(),
})

const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()

/** The names in `item` that `filter` selects, run on a real SQLite. */
async function namesMatching(harness: LibsqlHarness, filter: string, names: string[]) {
	const condition = parseFilter(filter)?.root.conditions[0]
	const built = conditionToSQL(condition!, item.name)
	expect(built).not.toBeNull()
	const { params, sql } = dialect.sqlToQuery(built!)
	await harness.client.execute("CREATE TABLE item (name TEXT NOT NULL)")
	await harness.client.execute({
		args: names,
		sql: `INSERT INTO item (name) VALUES ${names.map(() => "(?)").join(", ")}`,
	})
	const result = await harness.client.execute({ args: params as string[], sql: `SELECT name FROM item WHERE ${sql}` })
	return { names: result.rows.map((row) => row.name), params, sql }
}

describe("name.like.% / name.ilike.% against SQLite", () => {
	let harness: LibsqlHarness | undefined

	afterEach(() => {
		harness?.close()
		harness = undefined
	})

	it("matches the character %, not every row", async () => {
		/* like lowers to GLOB, where % is not special at all */
		expect(globPattern("%")).toBe("%")
		expect(likePattern("%")).toBe("\\%")
		expect(parseFilter("name.like.%")?.root.conditions[0]?.value).toBe("%")

		harness = libsqlMemory()
		const result = await namesMatching(harness, "name.like.%", ["alice", "bob", "100%", "%"])
		expect(result.params).toEqual(["%"])
		expect(result.sql.toLowerCase()).toContain("glob")
		expect(result.names).toEqual(["%"])
	})

	it("ilike escapes % for LIKE and still matches only the character", async () => {
		harness = libsqlMemory()
		const result = await namesMatching(harness, "name.ilike.%", ["alice", "100%", "%"])
		expect(result.params).toEqual(["\\%"])
		expect(result.names).toEqual(["%"])
	})
})

describe("likeSearch over a _search column searchText wrote (Q14)", () => {
	const post = sqliteTable("post", { _search: text("_search").notNull(), title: text("title").notNull() })

	it("finds an accented title by any spelling of its words", async () => {
		const harness = libsqlMemory()
		try {
			await harness.client.execute("CREATE TABLE post (title TEXT NOT NULL, _search TEXT NOT NULL)")
			for (const title of ["Évaluation des risques", "Crème brûlée", "Plain"])
				await harness.client.execute({ args: [title, searchText(title)], sql: "INSERT INTO post VALUES (?, ?)" })
			const titles = async (q: string) =>
				(
					await harness.db
						.select({ title: post.title })
						.from(post)
						.where(likeSearch(post._search)(q) as SQL)
				).map((row) => row.title)
			for (const q of ["Évaluation", "evaluation", "EVALUATION risques"])
				expect(await titles(q)).toEqual(["Évaluation des risques"])
			for (const q of ["brûlée", "brulee", "CRÈME"]) expect(await titles(q)).toEqual(["Crème brûlée"])
		} finally {
			harness.close()
		}
	})
})
