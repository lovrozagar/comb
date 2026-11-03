import { beforeAll, describe, expect, it } from "vitest"
import { loadPostgresParser } from "./pg-parser.ts"
import { bareRole, createRole } from "./pg-replay-roles.ts"
import { pgRead } from "./pg-split.ts"
import { nodeOf } from "./pg-outside-transaction.ts"

beforeAll(loadPostgresParser)

const coded = (code: string, message = code) => Object.assign(new Error(message), { code })

/** A postgres.js stand-in: each query it was sent, answering each with `answer`'s rows or error */
function fake(answer: (query: string) => Array<Record<string, unknown>> | Error = () => []) {
	const sent: string[] = []
	return {
		sent,
		sql: {
			unsafe: async (query: string) => {
				sent.push(query)
				const rows = answer(query)
				if (rows instanceof Error) throw rows
				return rows
			},
		} as unknown as Parameters<typeof createRole>[0],
	}
}

const found = (description: string | null) => [{ description }]

describe("createRole", () => {
	const made = { database: "comb_replay_7_9_x", owner: "7_9", role: "r", sent: "CREATE ROLE r" }

	it("makes, tags and holds a role that does not exist, in a savepoint, and owns it", async () => {
		const sql = fake()
		expect(await createRole(sql.sql, made)).toBe(true)
		expect(sql.sent.slice(1)).toEqual([
			"SAVEPOINT comb_role",
			"CREATE ROLE r",
			`COMMENT ON ROLE "r" IS 'comb_replay 7_9'`,
			'GRANT CONNECT ON DATABASE comb_replay_7_9_x TO "r"',
			"RELEASE SAVEPOINT comb_role",
		])
	})

	it("holds a role that exists, owning it only when a replay tagged it", async () => {
		const untagged = fake((query) => (query.startsWith("SELECT") ? found(null) : []))
		expect(await createRole(untagged.sql, made)).toBe(false)
		expect(untagged.sent.slice(1)).toEqual([
			"SAVEPOINT comb_role",
			'GRANT CONNECT ON DATABASE comb_replay_7_9_x TO "r"',
			"RELEASE SAVEPOINT comb_role",
		])
		const tagged = fake((query) => (query.startsWith("SELECT") ? found("comb_replay 3_4") : []))
		expect(await createRole(tagged.sql, made)).toBe(true)
	})

	it("reads the role again when another replay made it or dropped it since the read", async () => {
		/* made by another (42710), then dropped (42704), then made in the catalog's race (23505), then free */
		const reads = [[], found("comb_replay 3_4"), [], []]
		const [raced, dropped] = [["42710", "23505"], ["42704"]]
		const sql = fake((query) => {
			if (query.startsWith("SELECT")) return reads.shift() ?? []
			if (query === "CREATE ROLE r") return raced.length > 0 ? coded(raced.shift() ?? "") : []
			if (query.startsWith("GRANT") && dropped.length > 0) return coded(dropped.shift() ?? "")
			return []
		})
		expect(await createRole(sql.sql, made)).toBe(true)
		expect(sql.sent.filter((query) => query.startsWith("ROLLBACK"))).toHaveLength(3)
		expect(reads).toEqual([])
	})

	it("throws what is not a race, for a role that exists and one it makes", async () => {
		const sql = fake((query) => (query.startsWith("SELECT") ? found(null) : coded("42501", "denied")))
		await expect(createRole(sql.sql, made)).rejects.toThrow("denied")
		const making = fake((query) => (query === "CREATE ROLE r" ? coded("42501", "no CREATEROLE") : []))
		await expect(createRole(making.sql, made)).rejects.toThrow("no CREATEROLE")
	})
})

/** The CREATE ROLE a replay runs for the history's `text`, given the roles it made */
const bare = (text: string, made: readonly string[] = []) => {
	const [, node] = nodeOf(pgRead(text).statements[0]?.tree ?? [])
	return bareRole(node, made)
}

describe("bareRole", () => {
	it("makes a role bare, whole when the history said nothing more", () => {
		expect(bare("CREATE ROLE app;")).toEqual({
			sql: 'CREATE ROLE "app" NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS',
			whole: true,
			within: [],
		})
		expect(bare("CREATE ROLE app NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;").whole).toBe(true)
	})

	it("leaves out a login, a superuser, a password and CREATE USER's login, so not whole", () => {
		for (const text of [
			"CREATE ROLE ops LOGIN;",
			"CREATE ROLE ops SUPERUSER;",
			"CREATE ROLE ops PASSWORD 'p';",
			"CREATE ROLE ops CREATEDB;",
			"CREATE USER ops;",
		])
			expect(bare(text)).toMatchObject({
				sql: 'CREATE ROLE "ops" NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS',
				whole: false,
			})
	})

	it("keeps the memberships among roles the replay made, and leaves out any naming another", () => {
		expect(bare("CREATE ROLE app IN ROLE base ROLE member ADMIN boss;", ["base", "member", "boss"])).toEqual({
			sql: 'CREATE ROLE "app" NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS IN ROLE "base" ROLE "member" ADMIN "boss"',
			whole: true,
			within: ["base"],
		})
		expect(bare("CREATE ROLE app IN ROLE base, pg_read_all_data;", ["base"])).toEqual({
			sql: 'CREATE ROLE "app" NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS',
			whole: false,
			within: [],
		})
		expect(bare("CREATE ROLE app ROLE CURRENT_USER;", ["app"]).whole).toBe(false)
	})
})
