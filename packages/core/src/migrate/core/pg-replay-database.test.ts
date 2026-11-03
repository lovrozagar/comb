import { describe, expect, it, vi } from "vitest"
import { copyExtensions, dropRole, makeDatabase, ownerOf, STALE_MS, sweep, sweepDev } from "./pg-replay-database.ts"

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
	/* the server's backends: 5 a live replay's, 6 another role's whose start this role cannot read, 7 one that reused a dead replay's pid */
	const SESSIONS = [
		{ datname: "dev", pid: 5, start: "222" },
		{ datname: "dev", pid: 6, start: null },
		{ datname: "dev", pid: 7, start: "999" },
		{ datname: "comb_replay_9_555_eeeeeeee", pid: 8, start: "1" },
	]

	/** What a sweep at `now` dropped of these databases and tagged roles, the drops of those `fail` names failing */
	async function swept(fail: (query: string) => boolean = () => false) {
		const admin = fake((query) => {
			if (query.startsWith("SELECT pid")) return SESSIONS
			if (query.startsWith("SELECT datname"))
				return [
					`comb_replay_${old}_00000000`,
					`comb_replay_${young}_00000000`,
					"comb_replay_other",
					"comb_replay_9_111_aaaaaaaa",
					"comb_replay_5_222_bbbbbbbb",
					"comb_replay_6_333_cccccccc",
					"comb_replay_7_444_dddddddd",
					"comb_replay_9_555_eeeeeeee",
				].map((datname) => ({ datname }))
			if (query.startsWith("SELECT r.rolname"))
				return [
					{ description: `comb_replay ${old}`, rolname: "stale" },
					{ description: `comb_replay ${young}`, rolname: "fresh" },
					{ description: "comb_replay by hand", rolname: "kept" },
					{ description: "comb_replay 9_111", rolname: "dead" },
					{ description: "comb_replay 5_222", rolname: "live" },
				]
			if (fail(query)) return new Error("database is being accessed by other users")
			return []
		})
		await sweep(admin.sql, now)
		return admin.sent.filter((query) => query.startsWith("DROP"))
	}

	it("drops what a replay whose backend is gone made, and what 0.19 made over an hour ago, and keeps the rest", async () => {
		expect(await swept()).toEqual([
			`DROP DATABASE IF EXISTS "comb_replay_${old}_00000000"`,
			'DROP DATABASE IF EXISTS "comb_replay_9_111_aaaaaaaa"',
			'DROP DATABASE IF EXISTS "comb_replay_7_444_dddddddd"',
			'DROP ROLE IF EXISTS "stale"',
			'DROP ROLE IF EXISTS "dead"',
		])
	})

	it("goes on past a drop that fails, which the next run takes", async () => {
		const dropped = await swept((query) => query.includes("9_111"))
		expect(dropped).toContain('DROP DATABASE IF EXISTS "comb_replay_7_444_dddddddd"')
		expect(dropped).toContain('DROP ROLE IF EXISTS "dead"')
	})
})

describe("ownerOf", () => {
	it("names the backend a connection runs on by its pid and its start", async () => {
		const admin = fake(() => [{ pid: 41, start: "1793680844883080" }])
		expect(await ownerOf(admin.sql)).toBe("41_1793680844883080")
		expect(admin.sent).toEqual([expect.stringMatching(/FROM pg_stat_activity WHERE pid = pg_backend_pid\(\)$/)])
	})
})

describe("sweepDev, before an apply", () => {
	const TARGET = { devUrl: "postgres://dev/dev", lockTimeout: "5s", schema: "public", url: "postgres://app/app" }

	it("sweeps devUrl's server on a connection of its own, and closes it", async () => {
		const admin = fake()
		let ended = 0
		const given: Array<Record<string, unknown>> = []
		await sweepDev(TARGET, async () => (options) => {
			given.push(options)
			return { ...admin.sql, end: async () => void ended++ }
		})
		expect(admin.sent[0]).toMatch(/FROM pg_stat_activity$/)
		expect([given[0]?.["database"], given[0]?.["max"], ended]).toEqual(["dev", 1, 1])
	})

	it("sweeps nothing on Atlas's docker:// container, and stops no apply when it cannot", async () => {
		let loaded = 0
		await sweepDev({ ...TARGET, devUrl: "docker://postgres/17/dev" }, async () => {
			loaded++
			return () => fake().sql
		})
		expect(loaded).toBe(0)
		await expect(
			sweepDev(TARGET, async () => {
				throw new Error("comb needs postgres")
			}),
		).resolves.toBeUndefined()
		let ended = 0
		const down = fake(() => new Error("connection refused"))
		await expect(
			sweepDev(TARGET, async () => () => ({ ...down.sql, end: async () => void ended++ })),
		).resolves.toBeUndefined()
		expect(ended).toBe(1)
	})

	/* a server only notices a drop of what it already dropped, which a fresh one never holds */
	it("prints nothing of a notice its drops raise", async () => {
		let onnotice: unknown
		await sweepDev(TARGET, async () => (options) => {
			onnotice = options["onnotice"]
			return fake().sql
		})
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
		try {
			expect(onnotice).toBeTypeOf("function")
			;(onnotice as (notice: unknown) => void)({ message: 'role "comb_replay_1" does not exist, skipping' })
			expect(log).not.toHaveBeenCalled()
		} finally {
			log.mockRestore()
		}
	})
})

describe("makeDatabase", () => {
	it("makes a database named for the backend that owns it, from template0", async () => {
		const admin = fake()
		const name = await makeDatabase(admin.sql, "41_1234", () => new Error("refused"))
		expect(name).toMatch(/^comb_replay_41_1234_[0-9a-f]{8}$/)
		expect(admin.sent).toEqual([`CREATE DATABASE ${name} TEMPLATE template0`])
	})

	it("refuses a role without CREATEDB, and throws any other failure", async () => {
		const denied = fake(() => coded("42501"))
		await expect(makeDatabase(denied.sql, "1_1", () => new Error("no CREATEDB"))).rejects.toThrow("no CREATEDB")
		const full = fake(() => coded("53100", "disk full"))
		await expect(makeDatabase(full.sql, "1_1", () => new Error("no CREATEDB"))).rejects.toThrow("disk full")
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
