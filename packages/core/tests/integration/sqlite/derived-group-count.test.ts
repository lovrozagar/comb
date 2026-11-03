/**
 * Q14 of r18: a derived list's count is a window function, which SQL evaluates after GROUP BY and
 * before DISTINCT. The README tells a list that dedupes a join to GROUP BY its id (or use EXISTS);
 * this pins that GROUP BY counts the listed rows, and shows the DISTINCT count it warns of.
 */
import { type SQL, sql } from "drizzle-orm"
import { afterEach, describe, expect, it } from "vitest"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { buildDerivedListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"

let harness: LibsqlHarness | undefined
afterEach(() => harness?.close())

const schema = createListQuerySchema({ sort: ["id"] })

/** The extras of `built` as raw SQL selects them, in the README's form */
const selected = (built: { extras: Record<string, SQL.Aliased> }): SQL =>
	sql.join(
		Object.values(built.extras).map((extra) => sql`${extra.sql} AS ${sql.identifier(extra.fieldAlias)}`),
		sql`, `,
	)

/* two users with posts tagged x: u1 with three, u2 with two; u3 with one untagged */
async function seeded(): Promise<LibsqlHarness> {
	const made = libsqlMemory()
	await made.client.executeMultiple(`CREATE TABLE users (id TEXT PRIMARY KEY);
CREATE TABLE posts (id TEXT PRIMARY KEY, user_id TEXT, tag TEXT);
INSERT INTO users VALUES ('u1'), ('u2'), ('u3');
INSERT INTO posts VALUES ('p1', 'u1', 'x'), ('p2', 'u1', 'x'), ('p3', 'u1', 'x'), ('p4', 'u2', 'x'), ('p5', 'u2', 'x'), ('p6', 'u3', 'y');`)
	return made
}

describe("a derived list over a join, deduped", () => {
	it("counts the users a GROUP BY lists, not their joined posts", async () => {
		harness = await seeded()
		const built = buildDerivedListQuery({
			...SEALED,
			dialect: "sqlite",
			idColumn: sql`users.id`,
			parsed: schema.parse({ limit: "10", order: "id.asc" }),
			sortColumns: { id: sql`users.id` },
		})
		const query = sql`SELECT users.id AS id, ${selected(built)} FROM users JOIN posts ON posts.user_id = users.id WHERE posts.tag = 'x' GROUP BY users.id ORDER BY ${sql.join(built.orderBy, sql`, `)} LIMIT ${built.limit} OFFSET ${built.offset}`
		const rows = (await harness.db.all(query)) as Array<Record<string, unknown>>
		const [items, meta] = queryHelpers.paginate(rows, built)
		expect([items.map(({ id }) => id), meta.count]).toEqual([["u1", "u2"], 2])
	})

	it("counts the joined rows under DISTINCT, as the README warns", async () => {
		harness = await seeded()
		const built = buildDerivedListQuery({
			...SEALED,
			dialect: "sqlite",
			idColumn: sql`users.id`,
			parsed: schema.parse({ limit: "10", order: "id.asc" }),
			sortColumns: { id: sql`users.id` },
		})
		const query = sql`SELECT DISTINCT users.id AS id, ${selected(built)} FROM users JOIN posts ON posts.user_id = users.id WHERE posts.tag = 'x' ORDER BY ${sql.join(built.orderBy, sql`, `)} LIMIT ${built.limit} OFFSET ${built.offset}`
		const rows = (await harness.db.all(query)) as Array<Record<string, unknown>>
		expect(queryHelpers.paginate(rows, built)[1].count).toBe(5)
	})
})
