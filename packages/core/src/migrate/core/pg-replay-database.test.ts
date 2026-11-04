import { describe, expect, it, vi } from "vitest"
import { claim, copyExtensions, dropRole, makeDatabase, STALE_MS, sweep, sweepDev } from "./pg-replay-database.ts"

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

/*
 * the server's backends: 5 a live replay's, 6 another role's whose start this role cannot read, 7 one
 * that reused a dead replay's pid; in dead replays' databases, 8 a person's psql, 10 the replay's own
 * left running, and 11 that replay's in another's database, which is no session of that one's
 */
const SESSIONS = [
	{ datname: "dev", pid: 5, start: "222" },
	{ datname: "dev", pid: 6, start: null },
	{ datname: "dev", pid: 7, start: "999" },
	{ app: "psql", datname: "comb_replay_9_555_eeeeeeee", pid: 8, start: "1" },
	{ app: "comb_replay 9_666", datname: "comb_replay_9_666_ffffffff", pid: 10, start: "1" },
	{ app: "comb_replay 9_666", datname: "comb_replay_9_777_abababab", pid: 11, start: "1" },
]

describe("sweep", () => {
	const now = 10 * STALE_MS
	const old = now - STALE_MS - 1
	const young = now - STALE_MS

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
					"comb_replay_9_666_ffffffff",
					"comb_replay_9_777_abababab",
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
		return admin.sent.filter((query) => query.startsWith("DROP") || query.includes("pg_terminate_backend"))
	}

	it("drops what a replay whose backend is gone made, and what 0.19 made over an hour ago, and keeps the rest", async () => {
		expect(await swept()).toEqual([
			`DROP DATABASE IF EXISTS "comb_replay_${old}_00000000"`,
			'DROP DATABASE IF EXISTS "comb_replay_9_111_aaaaaaaa"',
			'DROP DATABASE IF EXISTS "comb_replay_7_444_dddddddd"',
			"SELECT pg_terminate_backend($1)",
			'DROP DATABASE IF EXISTS "comb_replay_9_666_ffffffff"',
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

/* P4 of r22: the server stubbed below 14, which has no client_connection_check_interval, at 14 and on CI's 17 */
/* P4 of r22: a replay killed past its cleanup leaves its statement running in its database; PR8 of r22b: whoever made it */
describe("sweep of a replay killed mid-statement", () => {
	it("ends a dead replay's own backends before it drops their database, of every role it may drop, but one with any other session", async () => {
		const admin = fake((query) =>
			query.startsWith("SELECT pid")
				? [{ app: "comb_replay 9_666", datname: "comb_replay_9_666_ffffffff", pid: 10, start: "1" }]
				: query.startsWith("SELECT datname")
					? [{ datname: "comb_replay_9_666_ffffffff" }]
					: [],
		)
		await sweep(admin.sql, 10 * STALE_MS)
		expect(admin.sent[1]).toMatch(/AND pg_has_role\(datdba, 'USAGE'\)$/)
		expect(admin.sent[1]).not.toContain("current_user")
		expect(admin.sent.slice(3, 5)).toEqual([
			"SELECT pg_terminate_backend($1)",
			'DROP DATABASE IF EXISTS "comb_replay_9_666_ffffffff"',
		])
	})
})

describe("claim", () => {
	it.each([
		[130000, { application_name: "comb_replay 41_1793680844883080" }],
		[140000, { application_name: "comb_replay 41_1793680844883080", client_connection_check_interval: "1s" }],
		[170000, { application_name: "comb_replay 41_1793680844883080", client_connection_check_interval: "1s" }],
	])(
		"names the backend by its pid and its start, and on server_version_num %i tags it with %j",
		async (version, settings) => {
			const admin = fake((query) =>
				query.startsWith("SELECT pid") ? [{ pid: 41, start: "1793680844883080", version }] : [],
			)
			expect(await claim(admin.sql)).toEqual({ owner: "41_1793680844883080", settings })
			expect(admin.sent[0]).toMatch(
				/current_setting\('server_version_num'\)::int AS version FROM pg_stat_activity WHERE pid = pg_backend_pid\(\)$/,
			)
			expect(admin.sent[1]).toBe(
				`SELECT ${Object.keys(settings)
					.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, false)`)
					.join(", ")}`,
			)
		},
	)
})

/** A connector whose target server holds a role a dead replay tagged, or nothing, each connection's options and end kept */
function servers(left: boolean, dev: ReturnType<typeof fake> = fake()) {
	const given: Array<Record<string, unknown>> = []
	let ended = 0
	const target = fake((query) =>
		left && query.startsWith("SELECT r.rolname") ? [{ description: "comb_replay 9_111", rolname: "dead" }] : [],
	)
	const load = async () => (options: Record<string, unknown>) => {
		given.push(options)
		return { ...(given.length === 1 ? target.sql : dev.sql), end: async () => void ended++ }
	}
	return { dev, ended: () => ended, given, load }
}

const TARGET = { devUrl: "postgres://dev/dev", lockTimeout: "5s", schema: "public", url: "postgres://app/app" }
const print = (): void => undefined

describe("sweepDev, before an apply", () => {
	/* PR7 of r22b: a devUrl the deploy cannot reach cost every apply postgres.js's 30 s connect timeout */
	it("asks the target's server first, and connects to no devUrl when it holds nothing a sweep would take", async () => {
		const at = servers(false)
		await sweepDev(TARGET, print, at.load)
		expect([at.given.map((options) => options["database"]), at.ended(), at.dev.sent]).toEqual([["app"], 1, []])
		/* a live replay's, or one another role's database holds, is no sweep's */
		const live = fake((query) =>
			query.startsWith("SELECT pid")
				? [{ app: "", datname: "comb_replay_9_111_aaaaaaaa", pid: 3, start: "1" }]
				: query.startsWith("SELECT datname")
					? [{ datname: "comb_replay_9_111_aaaaaaaa" }, { datname: "comb_replay_3_1_bbbbbbbb" }]
					: [],
		)
		const dev: Array<Record<string, unknown>> = []
		await sweepDev(TARGET, print, async () => (options) => (dev.push(options), live.sql))
		expect(dev).toHaveLength(1)
		expect(live.sent[1]).not.toContain("pg_has_role")
	})

	it("sweeps devUrl's server on a connection of its own, waiting 5 s for it, and closes both", async () => {
		const at = servers(true)
		await sweepDev(TARGET, print, at.load)
		expect(at.dev.sent[0]).toMatch(/FROM pg_stat_activity$/)
		const dev = at.given[1] ?? {}
		expect([dev["database"], dev["max"], dev["connect_timeout"], at.ended()]).toEqual(["dev", 1, 5, 2])
		const own = servers(true)
		await sweepDev({ ...TARGET, devUrl: "postgres://dev/dev?connect_timeout=2" }, print, own.load)
		expect(own.given[1]?.["connect_timeout"]).toBe(2)
	})

	/* a server only notices a drop of what it already dropped, which a fresh one never holds */
	it("prints nothing of a notice its drops raise", async () => {
		const at = servers(true)
		await sweepDev(TARGET, print, at.load)
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
		try {
			for (const options of at.given) {
				expect(options["onnotice"]).toBeTypeOf("function")
				;(options["onnotice"] as (notice: unknown) => void)({
					message: 'role "comb_replay_1" does not exist, skipping',
				})
			}
			expect(log).not.toHaveBeenCalled()
		} finally {
			log.mockRestore()
		}
	})
})

describe("sweepDev that cannot sweep", () => {
	it("sweeps nothing on Atlas's docker:// container, and stops no apply when it cannot, saying so when devUrl fails", async () => {
		let loaded = 0
		await sweepDev({ ...TARGET, devUrl: "docker://postgres/17/dev" }, print, async () => {
			loaded++
			return () => fake().sql
		})
		expect(loaded).toBe(0)
		await expect(
			sweepDev(TARGET, print, async () => {
				throw new Error("comb needs postgres")
			}),
		).resolves.toBeUndefined()
		const said: string[] = []
		const down = servers(
			true,
			fake(() => new Error("connect ETIMEDOUT for u with hunter2")),
		)
		await expect(
			sweepDev({ ...TARGET, devUrl: "postgres://u:hunter2@dev/dev" }, (line) => said.push(line), down.load),
		).resolves.toBeUndefined()
		expect(down.ended()).toBe(2)
		expect(said).toEqual([
			expect.stringMatching(
				/^Apply did not sweep what a killed check left on the target's server, as devUrl's server did not answer: connect ETIMEDOUT .*; a CREATE ROLE of a role it left stops apply/,
			),
		])
		expect(said[0]).not.toContain("hunter2")
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
