import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { liveDrift, loadPostgres, pastStops, readLiveObjects } from "./pg-live-objects.ts"
import { openedWhileStopping } from "../../../tests/support/signals.ts"
import type { LiveObjects } from "./pg-live-types.ts"
import { noLive } from "../__fixtures__/live-objects.ts"

const TARGET = { devUrl: "postgres://dev/x", lockTimeout: "5s", schema: "app", url: "postgres://app:s3cret@db/app" }

/** A postgres.js stand-in answering `rows`, or failing with `error`; what it was asked */
function fakeConnect(answer: { error?: Error; rows?: Array<Record<string, unknown>> }) {
	const seen = { ended: false, options: {} as Record<string, unknown>, params: [] as unknown[] }
	const connect = (options: Record<string, unknown>) => {
		seen.options = options
		return {
			end: async () => void (seen.ended = true),
			unsafe: async (_query: string, params: unknown[]) => {
				seen.params = params
				if (answer.error !== undefined) throw answer.error
				return answer.rows ?? []
			},
		}
	}
	return { load: async () => connect, seen }
}

/** One catalog read: each kind of row it answers with */
const ROWS: Array<Record<string, unknown>> = [
	{ kind: "function", name: "f", on_table: null, signature: "", what: "routine" },
	{ kind: "function", name: "f", on_table: null, signature: "int4,text[]", what: "routine" },
	{ kind: "procedure", name: "p", on_table: null, signature: "other.mood", what: "routine" },
	{ enabled: true, name: "t_ai", on_table: "t", tgtype: 5, what: "trigger" },
	{ enabled: false, name: "t_bu", on_table: "t", tgtype: 19, what: "trigger" },
	{ kind: "view", name: "v", on_table: null, what: "relation" },
	{
		how: "start 1, increment 1, min 1, max 9, no cycle",
		kind: "sequence",
		name: "s",
		on_table: null,
		what: "relation",
	},
	{ how: "for all, to public, permissive", kind: null, name: "own", on_table: "t", what: "policy" },
	{ how: "for select, to a, b, restrictive", kind: null, name: "mine", on_table: "t", what: "policy" },
	{ kind: "domain", name: "positive", on_table: null, what: "kind" },
	{ kind: null, name: "keep", on_table: "t", what: "rule" },
	{ how: "enabled, not forced", kind: null, name: "t", on_table: null, what: "rls" },
	{ kind: null, name: "citext", on_table: null, what: "extension" },
	{ kind: null, name: "operator @@@(none, int4)", on_table: null, what: "other" },
	{ kind: null, name: "publication pub", on_table: null, what: "platform" },
	{ kind: null, name: "app", on_table: null, what: "user" },
]

/* plan 14's 5.4b: what the database holds of what Atlas OSS does not compare */
describe("readLiveObjects", () => {
	it("reads each routine's overloads, each table's triggers and policies, and the views and sequences, and closes the connection", async () => {
		const { load, seen } = fakeConnect({ rows: ROWS })
		expect(await readLiveObjects(TARGET, load)).toEqual({
			extensions: new Set(["citext"]),
			kinds: new Map([["positive", "domain"]]),
			others: new Set(["operator @@@(none, int4)"]),
			platform: new Set(["publication pub"]),
			policies: new Map([
				[
					"t",
					new Map([
						["own", "for all, to public, permissive"],
						["mine", "for select, to a, b, restrictive"],
					]),
				],
			]),
			rls: new Map([["t", "enabled, not forced"]]),
			rules: new Map([["t", new Set(["keep"])]]),
			sequences: new Map([["s", "start 1, increment 1, min 1, max 9, no cycle"]]),
			user: "app",
			relations: new Map([
				["v", "view"],
				["s", "sequence"],
			]),
			routines: new Map([
				["f", { kind: "function", signatures: new Set(["", "int4,text[]"]) }],
				["p", { kind: "procedure", signatures: new Set(["other.mood"]) }],
			]),
			triggers: new Map([
				[
					"t",
					new Map([
						["t_ai", { enabled: true, type: 5 }],
						["t_bu", { enabled: false, type: 19 }],
					]),
				],
			]),
		})
		expect(seen).toEqual({
			ended: true,
			options: { database: "app", host: "db", max: 1, password: "s3cret", port: 5432, ssl: "require", username: "app" },
			params: ["app"],
		})
	})

	it("says why it could not read, with the password masked, and closes the connection still", async () => {
		const { load, seen } = fakeConnect({ error: new Error("password authentication failed for s3cret") })
		await expect(readLiveObjects(TARGET, load)).rejects.toThrow(
			/^comb could not read the database's functions, procedures, triggers, views, materialized views, sequences, policies, domains, composite types, range types, collations, rules, row level security, extensions, aggregates, SECURITY DEFINER, operators, casts, views' options, materialized views' indexes, replica identity, event triggers and publications: password authentication failed for (?!s3cret)/,
		)
		expect(seen.ended).toBe(true)
	})
})

/** A postgres.js stand-in, each query it sent */
function sending() {
	const sent: string[] = []
	return {
		connect: () => ({ end: async () => undefined, unsafe: async (query: string) => (sent.push(query), []) }),
		sent,
	}
}

describe("loadPostgres", () => {
	it("loads postgres.js, the optional peer", async () => {
		expect(typeof (await loadPostgres("comb reads it"))).toBe("function")
	})

	/* r22b: postgres.js opens a backend at a connection's first query, which a stopping run must not start */
	it("sends a query only once a signal's stop is past", async () => {
		const server = sending()
		const sql = pastStops(server.connect)({})
		const { early } = await openedWhileStopping(() => sql.unsafe("SELECT 1", []))
		expect([early, server.sent]).toEqual([false, ["SELECT 1"]])
	})

	it("gates every connection of what it loads", async () => {
		const server = sending()
		vi.doMock("postgres", () => ({ default: server.connect }))
		try {
			const connect = await loadPostgres("read it")
			const { early } = await openedWhileStopping(() => connect({}).unsafe("SELECT 2", []))
			expect([early, server.sent]).toEqual([false, ["SELECT 2"]])
		} finally {
			vi.doUnmock("postgres")
		}
	})

	it("refuses, naming the package and its range, when the peer is missing", async () => {
		vi.doMock("postgres", () => {
			throw new Error("Cannot find package 'postgres'")
		})
		vi.resetModules()
		try {
			const { loadPostgres: missing } = await import("./pg-live-objects.ts")
			await expect(missing("read it")).rejects.toThrow(
				`comb needs postgres (>=3.4.9 <4) to read it; install "postgres@>=3.4.9 <4"`,
			)
			/* a baseline's own read says why it needs the peer */
			await expect(
				(await import("./pg-live-objects.ts")).readLiveObjects({ schema: "app", url: "postgres://db/db" }),
			).rejects.toThrow(
				`comb needs postgres (>=3.4.9 <4) to compare the database's functions, procedures, triggers, views, materialized views, sequences, policies, domains, composite types, range types, collations, rules, row level security, extensions, aggregates, SECURITY DEFINER, operators, casts, views' options, materialized views' indexes, replica identity, event triggers and publications, which Atlas OSS does not, in a baseline; install "postgres@>=3.4.9 <4"`,
			)
		} finally {
			vi.doUnmock("postgres")
		}
	})
})

/* P5 of r19: both sides are one catalog read, the history's from its replay on dev */
/** A catalog read holding `more` */
const read = (more: Partial<LiveObjects> = {}): LiveObjects => ({ ...noLive(), ...more })

/** A catalog read holding one routine f of `kind`, with `signature` */
const fn = (kind: "function" | "procedure", signature: string) =>
	read({ routines: new Map([["f", { kind, signatures: new Set([signature]) }]]) })

describe("liveDrift between two catalog reads", () => {
	it("names what only one side has, and counts what both have", () => {
		const history = read({
			relations: new Map([["v", "view" as const]]),
			routines: new Map([
				["f", { kind: "function" as const, signatures: new Set([""]) }],
				["g", { kind: "function" as const, signatures: new Set(["int4"]) }],
			]),
			triggers: new Map([["t", new Map([["t_ai", { enabled: true, type: 5 }]])]]),
		})
		const live = read({
			relations: new Map([["v", "view" as const]]),
			routines: new Map([
				["f", { kind: "function" as const, signatures: new Set([""]) }],
				["k", { kind: "procedure" as const, signatures: new Set(["int4"]) }],
			]),
			triggers: new Map([
				[
					"t",
					new Map([
						["t_ai", { enabled: true, type: 5 }],
						["t_x", { enabled: true, type: 64 | 8 | 32 }],
					]),
				],
			]),
		})
		expect(liveDrift(history, live)).toEqual({
			matched: { routines: 1, triggers: 1, views: 1 },
			only: [
				"function g(int4): only in the migrations",
				"procedure k(int4): only in the database",
				"trigger t_x on t (instead of delete or truncate, for each statement): only in the database",
			],
		})
	})

	it("is a match of kind as well as name, and of the signature as the catalog spells both", () => {
		expect(liveDrift(fn("function", ""), fn("procedure", "")).only).toEqual([
			"function f(): only in the migrations",
			"procedure f(): only in the database",
		])
		expect(liveDrift(fn("function", "int4[]"), fn("function", "int4")).only).toEqual([
			"function f(int4): only in the database",
			"function f(int4[]): only in the migrations",
		])
	})
})

describe("liveDrift on settings and extensions", () => {
	it("names a policy, row level security and a sequence by their settings, and refuses only a missing extension", () => {
		const history = read({
			extensions: new Set(["citext"]),
			policies: new Map([["t", new Map([["p", "for all, to public, restrictive"]])]]),
			relations: new Map([["s", "sequence" as const]]),
			rls: new Map([["t", "disabled, forced"]]),
			sequences: new Map([["s", "start 1, increment 1, min 1, max 9, no cycle"]]),
		})
		const live = read({
			extensions: new Set(["pg_stat_statements"]),
			relations: new Map([["s", "sequence" as const]]),
			sequences: new Map([["s", "start 1, increment 2, min 1, max 9, no cycle"]]),
		})
		expect(liveDrift(history, live).only).toEqual([
			"extension citext: only in the migrations",
			"policy p on t (for all, to public, restrictive): only in the migrations",
			"row level security on t (disabled, forced): only in the migrations",
			"sequence s (start 1, increment 1, min 1, max 9, no cycle): only in the migrations",
			"sequence s (start 1, increment 2, min 1, max 9, no cycle): only in the database",
		])
	})
})

/** What postgres.js was called with, by a stand-in that answers nothing */
function recording() {
	const calls: unknown[][] = []
	const connect = (...given: unknown[]) => (calls.push(given), { end: async () => undefined, unsafe: async () => [] })
	return { calls, load: async () => connect }
}

/*
 * P3, P4 and P14 of the 0.14.1 review: postgres.js reads none of libpq's query keys, and sends each
 * one it does not know to the server as a setting, so comb hands it the server libpq reads
 */
describe("readLiveObjects: the server libpq reads from the URL", () => {
	it("hands postgres.js the host, port, database and TLS libpq reads, and no libpq key as a setting", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-libpq-"))
		for (const name of ["root.crt", "client.crt", "client.key"]) writeFileSync(join(dir, name), name)
		const tls = `sslrootcert=${join(dir, "root.crt")}&sslcert=${join(dir, "client.crt")}&sslkey=${join(dir, "client.key")}`
		const { calls, load } = recording()
		const url = `postgres://app:s3%2Fcret@db.example.com/x?port=6000&dbname=app&sslmode=verify-full&${tls}&connect_timeout=5&application_name=comb`
		await readLiveObjects({ ...TARGET, url }, load)
		expect(calls).toEqual([
			[
				{
					connect_timeout: 5,
					connection: { application_name: "comb" },
					database: "app",
					host: "db.example.com",
					max: 1,
					password: "s3/cret",
					port: 6000,
					ssl: { ca: "root.crt", cert: "client.crt", key: "client.key", rejectUnauthorized: true },
					username: "app",
				},
			],
		])
	})
})

describe("readLiveObjects: a socket, verify-ca and no TLS, read as libpq reads them", () => {
	it("reaches a Unix socket by its directory, without TLS, and reads verify-ca's server by its certificate alone", async () => {
		const { calls, load } = recording()
		await readLiveObjects({ ...TARGET, url: "postgres://app:s3cret@/app?host=/run/postgresql" }, load)
		await readLiveObjects({ ...TARGET, url: "postgres://app@db:6432?sslmode=verify-ca" }, load)
		await readLiveObjects({ ...TARGET, url: "postgres://app@db/app?sslmode=disable" }, load)
		expect(calls).toEqual([
			[
				{
					database: "app",
					host: "/run/postgresql",
					max: 1,
					password: "s3cret",
					port: 5432,
					ssl: false,
					username: "app",
				},
			],
			[
				{
					database: "app",
					host: "db",
					max: 1,
					password: expect.any(Function),
					port: 6432,
					ssl: { checkServerIdentity: expect.any(Function), rejectUnauthorized: true },
					username: "app",
				},
			],
			[
				{
					database: "app",
					host: "db",
					max: 1,
					password: expect.any(Function),
					port: 5432,
					ssl: false,
					username: "app",
				},
			],
		])
	})
})

describe("readLiveObjects on a connection every address refused", () => {
	it("says nothing more than comb's own words for a failure with no message and no errors", async () => {
		await expect(readLiveObjects(TARGET, fakeConnect({ error: new Error("") }).load)).rejects.toThrow(
			/^comb could not read the database's functions, procedures, triggers, views, materialized views, sequences, policies, domains, composite types, range types, collations, rules, row level security, extensions, aggregates, SECURITY DEFINER, operators, casts, views' options, materialized views' indexes, replica identity, event triggers and publications: $/,
		)
	})

	/* P15 of the 0.15.0 review: postgres.js throws an AggregateError with no message when every address refuses */
	it("says what each address answered when the failure's own message is empty", async () => {
		const refused = new AggregateError(
			[new Error("connect ECONNREFUSED ::1:55433"), new Error("connect ECONNREFUSED 127.0.0.1:55433")],
			"",
		)
		await expect(readLiveObjects(TARGET, fakeConnect({ error: refused }).load)).rejects.toThrow(
			"comb could not read the database's functions, procedures, triggers, views, materialized views, sequences, policies, domains, composite types, range types, collations, rules, row level security, extensions, aggregates, SECURITY DEFINER, operators, casts, views' options, materialized views' indexes, replica identity, event triggers and publications: connect ECONNREFUSED ::1:55433; connect ECONNREFUSED 127.0.0.1:55433",
		)
	})
})

/* r18 P19: comb's own read of a server without TLS says what to set, on the field it read */
describe("readLiveObjects on a server without TLS", () => {
	it("says to set sslmode=disable on url", async () => {
		const { load } = fakeConnect({
			error: new Error("Client network socket disconnected before secure TLS connection was established"),
		})
		await expect(readLiveObjects(TARGET, load)).rejects.toThrow(
			"the server takes no TLS, which comb and Atlas require where url names no sslmode; set sslmode=disable on url for a server without TLS",
		)
	})
})

/* P2 of r19: the connection is built inside the read's try, so a TLS file it cannot open is named as the read's failure */
describe("readLiveObjects on a TLS file it cannot open", () => {
	it("says comb could not read the database, naming the file, never a bare ENOENT", async () => {
		const { load, seen } = fakeConnect({ rows: [] })
		await expect(
			readLiveObjects(
				{ ...TARGET, url: "postgres://app@db/app?sslmode=verify-ca&sslrootcert=/nonexistent/root.crt" },
				load,
			),
		).rejects.toThrow(
			/^comb could not read the database's .*: ENOENT: no such file or directory, open '\/nonexistent\/root\.crt'$/,
		)
		expect(seen.ended).toBe(false)
	})
})
