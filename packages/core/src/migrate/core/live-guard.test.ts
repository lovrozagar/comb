import { describe, expect, it } from "vitest"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { parseMigration } from "./parse.ts"
import type { Pending } from "./plan-apply.ts"
import { guardRebuilds } from "./rebuild-guard.ts"
import { extractSchema } from "./schema.ts"
import { refuseUnseenReach } from "./live-guard.ts"

const INIT =
	"CREATE TABLE `u` (`id` integer PRIMARY KEY);\nCREATE TABLE `post` (`id` integer PRIMARY KEY, `u` integer REFERENCES `u`(`id`) ON DELETE CASCADE);"
const BEFORE = extractSchema(INIT)
/* Atlas's rebuild of u, guarded as comb writes it */
const REBUILD = guardRebuilds(
	"CREATE TABLE `new_u` (`id` integer NOT NULL, PRIMARY KEY (`id`));\nINSERT INTO `new_u` (`id`) SELECT `id` FROM `u`;\nDROP TABLE `u`;\nALTER TABLE `new_u` RENAME TO `u`;\n",
	BEFORE,
)
const pending = (sql: string): Pending[] => [
	{ before: BEFORE, migration: parseMigration(sql, "2_rebuild.sql", { before: BEFORE }), name: "2_rebuild.sql", sql },
]

/** A libsql database the history made, with `outside` run on it as no migration did */
async function database(outside = "") {
	const conn = libsqlConnection()
	await conn.client.executeMultiple(`${INIT}\n${outside}`)
	return conn
}

describe("refuseUnseenReach on libsql", () => {
	it("lets a guarded rebuild through when the database reaches no further than its history", async () => {
		const conn = await database()
		await expect(refuseUnseenReach(conn, pending(REBUILD))).resolves.toBeUndefined()
		await expect(refuseUnseenReach(conn, pending("CREATE TABLE `t` (`x` integer);"))).resolves.toBeUndefined()
		await conn.close()
	})

	it("refuses a table no migration made that references the rebuilt one, and one that reaches it through another", async () => {
		for (const outside of [
			"CREATE TABLE `extra` (`u` integer REFERENCES `u`(`id`) ON DELETE CASCADE);",
			"CREATE TABLE `deep` (`p` integer REFERENCES `post`(`id`) ON DELETE CASCADE);",
		]) {
			const conn = await database(outside)
			const table = outside.includes("deep") ? "deep" : "extra"
			await expect(refuseUnseenReach(conn, pending(REBUILD))).rejects.toThrow(
				`2_rebuild.sql rebuilds u, which the database's table ${table} references although no migration made it do so`,
			)
			await conn.close()
		}
	})

	it("lets a trigger the history made through", async () => {
		const trigger = "CREATE TRIGGER `post_ai` AFTER INSERT ON `post` BEGIN SELECT 1; END;"
		const conn = await database(trigger)
		const before = extractSchema(trigger, BEFORE)
		const sql = REBUILD
		const known: Pending[] = [
			{ before, migration: parseMigration(sql, "2_rebuild.sql", { before }), name: "2_rebuild.sql", sql },
		]
		await expect(refuseUnseenReach(conn, known)).resolves.toBeUndefined()
		await conn.close()
	})

	it("refuses a trigger no migration made on a table the guard empties", async () => {
		const conn = await database("CREATE TRIGGER `audit` AFTER DELETE ON `post` BEGIN SELECT 1; END;")
		await expect(refuseUnseenReach(conn, pending(REBUILD))).rejects.toThrow(
			"2_rebuild.sql rebuilds u, and the database's trigger audit on post, which no migration made, would fire",
		)
		await conn.close()
	})
})

describe("refuseUnseenReach through a driver that reads in batches, as D1's does", () => {
	it("reads each table's keys by PRAGMA, skipping D1's own tables, and finds the same reach", async () => {
		const conn = await database(
			"CREATE TABLE `extra` (`u` integer REFERENCES `u`(`id`) ON DELETE CASCADE); CREATE TABLE `_cf_KV` (`k` text);",
		)
		const asked: string[][] = []
		const batched = {
			...conn,
			executeEach: async (statements: readonly string[]) => {
				asked.push([...statements])
				return Promise.all(statements.map((sql) => conn.execute(sql)))
			},
		}
		await expect(refuseUnseenReach(batched, pending(REBUILD))).rejects.toThrow("the database's table extra references")
		expect(asked).toEqual([
			['PRAGMA foreign_key_list("u")', 'PRAGMA foreign_key_list("post")', 'PRAGMA foreign_key_list("extra")'],
		])
		await conn.close()
	})
})
