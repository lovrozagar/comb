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

describe("refuseUnseenReach on a rebuild the history leaves unguarded, and across name case (M6, M7)", () => {
	const lone = "CREATE TABLE `u` (`id` integer PRIMARY KEY);"
	const loneBefore = extractSchema(lone)
	const unguarded =
		"CREATE TABLE `new_u` (`id` integer NOT NULL, PRIMARY KEY (`id`));\nINSERT INTO `new_u` (`id`) SELECT `id` FROM `u`;\nDROP TABLE `u`;\nALTER TABLE `new_u` RENAME TO `u`;\n"
	const lonePending: Pending[] = [
		{
			before: loneBefore,
			migration: parseMigration(unguarded, "2_rebuild.sql", { before: loneBefore }),
			name: "2_rebuild.sql",
			sql: unguarded,
		},
	]

	it("refuses a table no migration made that references a rebuilt table the history shows unreferenced", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			`${lone}\nCREATE TABLE \`sessions\` (\`u\` integer REFERENCES \`u\`(\`id\`) ON DELETE CASCADE);`,
		)
		await expect(refuseUnseenReach(conn, lonePending)).rejects.toThrow(
			"2_rebuild.sql rebuilds u, which the database's table sessions references although no migration made it do so",
		)
		await conn.close()
	})

	it("lets an unguarded rebuild through when nothing live reaches it, and its own triggers go with its drop", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple(`${lone}\nCREATE TRIGGER \`u_ai\` AFTER INSERT ON \`u\` BEGIN SELECT 1; END;`)
		await expect(refuseUnseenReach(conn, lonePending)).resolves.toBeUndefined()
		await conn.close()
	})

	it("sees a live table whose key names the rebuilt table in another case", async () => {
		const conn = await database("CREATE TABLE `audit` (`u` integer REFERENCES `U`(`id`) ON DELETE CASCADE);")
		await expect(refuseUnseenReach(conn, pending(REBUILD))).rejects.toThrow("the database's table audit references")
		await conn.close()
	})
})

describe("refuseUnseenReach on D1, which refuses a pragma that reaches its own tables", () => {
	it("reads every table's keys in one query, leaving out D1's own tables, and finds the same reach", async () => {
		const conn = await database(
			"CREATE TABLE `extra` (`u` integer REFERENCES `u`(`id`) ON DELETE CASCADE); CREATE TABLE `_cf_KV` (`k` text);",
		)
		const asked: string[] = []
		/* D1 as measured on a live database: pragma_foreign_key_list over the catalog is refused with
		   SQLITE_AUTH unless the _cf_ tables are left out first; each execute is one wrangler call */
		const d1 = {
			...conn,
			execute: (sql: string) => {
				asked.push(sql)
				if (sql.includes("pragma_foreign_key_list") && !sql.includes("NOT LIKE '\\_cf\\_%'"))
					return Promise.reject(new Error("not authorized: SQLITE_AUTH [code: 7500]"))
				return conn.execute(sql)
			},
			ownedPrefix: "_cf_",
		}
		await expect(refuseUnseenReach(d1, pending(REBUILD))).rejects.toThrow("the database's table extra references")
		expect(asked.filter((sql) => sql.includes("foreign_key_list"))).toHaveLength(1)
		await conn.close()
	})
})
