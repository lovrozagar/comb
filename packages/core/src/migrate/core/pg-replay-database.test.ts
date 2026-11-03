import { describe, expect, it } from "vitest"
import { copyExtensions, createRole, dropRole, makeDatabase, STALE_MS, sweep } from "./pg-replay-database.ts"

const coded = (code: string, message = code) => Object.assign(new Error(message), { code })

/** A postgres.js stand-in: each query it was sent, answering each with `answer`'s rows or error */
function fake(answer: (query: string) => Array<Record<string, unknown>> | Error = () => []) {
	const sent: string[] = []
	return {
		sent,
		sql: {
			end: async () => undefined,
			unsafe: async (query: string) => {
				sent.push(query)
				const rows = answer(query)
				if (rows instanceof Error) throw rows
				return rows
			},
		} as unknown as Parameters<typeof dropRole>[0],
	}
}

describe("dropRole", () => {
	it("drops the role", async () => {
		const admin = fake()
		await dropRole(admin.sql, "r")
		expect(admin.sent).toEqual(['DROP ROLE IF EXISTS "r"'])
	})

	it.each(["2BP01", "42501"])("leaves a role it cannot drop (%s) for a later sweep", async (code) => {
		const admin = fake((query) => (query.startsWith("DROP") ? coded(code) : []))
		await expect(dropRole(admin.sql, "r")).resolves.toBeUndefined()
		expect(admin.sent).toEqual(['DROP ROLE IF EXISTS "r"'])
	})

	it("takes a role another session dropped meanwhile as dropped", async () => {
		const admin = fake((query) => (query.startsWith("DROP") ? coded("XX000", "could not find tuple for role 1") : []))
		await expect(dropRole(admin.sql, "r")).resolves.toBeUndefined()
	})

	it("throws any other failure while the role is left", async () => {
		const admin = fake((query) => (query.startsWith("DROP") ? coded("57014", "canceled") : [{ "?column?": 1 }]))
		await expect(dropRole(admin.sql, "r")).rejects.toThrow("canceled")
	})
})

describe("sweep", () => {
	const now = 10 * STALE_MS
	const old = now - STALE_MS - 1
	const young = now - STALE_MS

	it("drops this role's replay databases and the tagged roles over an hour old, and keeps the rest", async () => {
		const admin = fake((query) => {
			if (query.startsWith("SELECT datname"))
				return [
					{ datname: `comb_replay_${old}_00000000` },
					{ datname: `comb_replay_${young}_00000000` },
					{ datname: "comb_replay_other" },
				]
			if (query.startsWith("SELECT r.rolname"))
				return [
					{ description: `comb_replay ${old}`, rolname: "stale" },
					{ description: `comb_replay ${young}`, rolname: "fresh" },
					{ description: "comb_replay by hand", rolname: "kept" },
				]
			return []
		})
		await sweep(admin.sql, now)
		expect(admin.sent.filter((query) => query.startsWith("DROP"))).toEqual([
			`DROP DATABASE IF EXISTS "comb_replay_${old}_00000000"`,
			'DROP ROLE IF EXISTS "stale"',
		])
	})
})

describe("makeDatabase", () => {
	it("makes a database named for the run's start, from template0", async () => {
		const admin = fake()
		const name = await makeDatabase(admin.sql, 1234, () => new Error("refused"))
		expect(name).toMatch(/^comb_replay_1234_[0-9a-f]{8}$/)
		expect(admin.sent).toEqual([`CREATE DATABASE ${name} TEMPLATE template0`])
	})

	it("refuses a role without CREATEDB, and throws any other failure", async () => {
		const denied = fake(() => coded("42501"))
		await expect(makeDatabase(denied.sql, 1, () => new Error("no CREATEDB"))).rejects.toThrow("no CREATEDB")
		const full = fake(() => coded("53100", "disk full"))
		await expect(makeDatabase(full.sql, 1, () => new Error("no CREATEDB"))).rejects.toThrow("disk full")
	})
})

describe("copyExtensions", () => {
	const held = [
		{ name: "plpgsql", schema: "pg_catalog", version: "1.0" },
		{ name: "citext", schema: "public", version: "1.6" },
		{ name: "pg_trgm", schema: "ext", version: "1'5" },
	]

	it("makes each extension in its schema at its version, making a schema of its own first", async () => {
		const to = fake()
		await copyExtensions(fake(() => held).sql, to.sql, { makes: new Set(), refused: () => new Error("refused") })
		expect(to.sent).toEqual([
			`CREATE EXTENSION IF NOT EXISTS "plpgsql" WITH SCHEMA "pg_catalog" VERSION '1.0'`,
			`CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "public" VERSION '1.6'`,
			'CREATE SCHEMA IF NOT EXISTS "ext"',
			`CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "ext" VERSION '1''5'`,
		])
	})

	it("refuses an extension it cannot make, naming it", async () => {
		const to = fake((query) => (query.includes("citext") ? coded("42501") : []))
		await expect(
			copyExtensions(fake(() => held).sql, to.sql, {
				makes: new Set(),
				refused: (name) => new Error(`cannot make ${name}`),
			}),
		).rejects.toThrow("cannot make citext")
	})

	/* P5 of r21 */
	it("leaves an extension the history makes to the history", async () => {
		const to = fake()
		await copyExtensions(fake(() => held).sql, to.sql, { makes: new Set(["citext"]), refused: () => new Error("x") })
		expect(to.sent.some((sent) => sent.includes("citext"))).toBe(false)
		expect(to.sent).toHaveLength(3)
	})
})

/** A role's row as createRole reads it, with its comment */
const found = (description: string | null) => [{ description }]

describe("createRole", () => {
	const made = { database: "comb_replay_1_x", role: "r", sent: "CREATE ROLE r", started: 7 }

	it("makes, tags and holds a role that does not exist, in a savepoint, and owns it", async () => {
		const sql = fake()
		expect(await createRole(sql.sql, made)).toBe(true)
		expect(sql.sent.slice(1)).toEqual([
			"SAVEPOINT comb_role",
			"CREATE ROLE r",
			`COMMENT ON ROLE "r" IS 'comb_replay 7'`,
			'GRANT CONNECT ON DATABASE comb_replay_1_x TO "r"',
			"RELEASE SAVEPOINT comb_role",
		])
	})

	it("holds a role that exists, owning it only when a replay tagged it", async () => {
		const untagged = fake((query) => (query.startsWith("SELECT") ? found(null) : []))
		expect(await createRole(untagged.sql, made)).toBe(false)
		expect(untagged.sent.slice(1)).toEqual([
			"SAVEPOINT comb_role",
			'GRANT CONNECT ON DATABASE comb_replay_1_x TO "r"',
			"RELEASE SAVEPOINT comb_role",
		])
		const tagged = fake((query) => (query.startsWith("SELECT") ? found("comb_replay 3") : []))
		expect(await createRole(tagged.sql, made)).toBe(true)
	})

	it("reads the role again when another replay made it or dropped it since the read", async () => {
		/* made by another (42710), then dropped (42704), then made in the catalog's race (23505), then free */
		const reads = [[], found("comb_replay 3"), [], []]
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
