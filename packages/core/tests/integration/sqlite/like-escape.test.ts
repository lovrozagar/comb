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
		/* a value with no * is a fixed text, compared with no pattern at all (U21) */
		expect(result.params).toEqual(["%"])
		expect(result.sql.toLowerCase()).not.toMatch(/\b(?:glob|like)\b/)
		expect(result.names).toEqual(["%"])
	})

	it("ilike matches only the character %, compared as a fixed text", async () => {
		harness = libsqlMemory()
		const result = await namesMatching(harness, "name.ilike.%", ["alice", "100%", "%"])
		expect(result.params).toEqual(["%"])
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
			for (const [title, ascii] of [
				["Straße", "strasse"],
				["Łódź", "lodz"],
				["Œuvre", "oeuvre"],
				["Ørsted", "orsted"],
				["Þingvellir", "thingvellir"],
			]) {
				await harness.client.execute({ args: [title, searchText(title)], sql: "INSERT INTO post VALUES (?, ?)" })
				expect(await titles(ascii as string)).toEqual([title])
				expect(await titles(title as string)).toEqual([title])
			}
		} finally {
			harness.close()
		}
	})
})

describe("likeSearch on a term that folds to no letter or digit (R7)", () => {
	const ROWS = ["Οδυσσέας ταξιδεύει", "page not found", "hello world", "café ´au lait"]

	/** The rows likeSearch finds for `q` over a `_search` column searchText wrote */
	async function found(q: string): Promise<unknown[]> {
		const harness = libsqlMemory()
		try {
			await harness.client.execute("CREATE TABLE doc (name TEXT NOT NULL, _search TEXT NOT NULL)")
			for (const name of ROWS)
				await harness.client.execute({ args: [name, searchText(name)], sql: "INSERT INTO doc VALUES (?, ?)" })
			const where = likeSearch(item.name)(q)
			if (where === null) return ["(no clause)"]
			const { params, sql } = dialect.sqlToQuery(where)
			const query = sql.replaceAll('"item"."name"', "_search")
			const result = await harness.client.execute({
				args: params as string[],
				sql: `SELECT name FROM doc WHERE ${query}`,
			})
			return result.rows.map((row) => row.name)
		} finally {
			harness.close()
		}
	}

	it.each(["́", "´", "¨", "˝", "´ ¨"])("finds no row for %j, as FTS does, instead of every row", async (q) => {
		expect(await found(q)).toEqual([])
	})

	it("drops such a term beside real ones", async () => {
		expect(await found("cafe ´")).toEqual(["café ´au lait"])
		expect(await found("hello ́")).toEqual(["hello world"])
	})

	it("adds no clause for a blank query", async () => {
		expect(likeSearch(item.name)("   ")).toBeNull()
	})
})
