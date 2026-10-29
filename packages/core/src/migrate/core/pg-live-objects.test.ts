import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { liveDrift, loadPostgres, readLiveObjects } from "./pg-live-objects.ts"
import type { LiveObjects } from "./pg-live-types.ts"
import { extractSchema } from "./schema.ts"

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

/* plan 14's 5.4b: what the database holds of what Atlas OSS does not compare */
describe("readLiveObjects", () => {
	it("reads each routine's overloads, each table's triggers and policies, and the views and sequences, and closes the connection", async () => {
		const { load, seen } = fakeConnect({
			rows: [
				{ kind: "function", name: "f", on_table: null, signature: "", what: "routine" },
				{ kind: "function", name: "f", on_table: null, signature: "int4,text[]", what: "routine" },
				{ kind: "procedure", name: "p", on_table: null, signature: "other.mood", what: "routine" },
				{ enabled: true, name: "t_ai", on_table: "t", tgtype: 5, what: "trigger" },
				{ enabled: false, name: "t_bu", on_table: "t", tgtype: 19, what: "trigger" },
				{ kind: "view", name: "v", on_table: null, what: "relation" },
				{ kind: "sequence", name: "s", on_table: null, what: "relation" },
				{ kind: null, name: "own", on_table: "t", what: "policy" },
				{ kind: null, name: "mine", on_table: "t", what: "policy" },
			],
		})
		expect(await readLiveObjects(TARGET, load)).toEqual({
			policies: new Map([["t", new Set(["own", "mine"])]]),
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
			options: { database: "app", host: "db", max: 1, password: "s3cret", port: 5432, ssl: "prefer", username: "app" },
			params: ["app"],
		})
	})

	it("says why it could not read, with the password masked, and closes the connection still", async () => {
		const { load, seen } = fakeConnect({ error: new Error("password authentication failed for s3cret") })
		await expect(readLiveObjects(TARGET, load)).rejects.toThrow(
			/^comb could not read the database's functions, triggers, views, sequences and policies: password authentication failed for (?!s3cret)/,
		)
		expect(seen.ended).toBe(true)
	})
})

describe("loadPostgres", () => {
	it("loads postgres.js, the optional peer", async () => {
		expect(typeof (await loadPostgres("comb reads it"))).toBe("function")
	})

	it("refuses, naming the package and its range, when the peer is missing", async () => {
		vi.doMock("postgres", () => {
			throw new Error("Cannot find package 'postgres'")
		})
		vi.resetModules()
		try {
			const { loadPostgres: missing } = await import("./pg-live-objects.ts")
			await expect(missing("comb reads it")).rejects.toThrow(
				"comb reads it; install postgres (>=3.4.9 <4), an optional peer, and run it again",
			)
			/* a baseline's own read says why it needs the peer */
			await expect(
				(await import("./pg-live-objects.ts")).readLiveObjects({ schema: "app", url: "postgres://db/db" }),
			).rejects.toThrow(
				"baseline compares the database's functions, triggers, views, sequences and policies, which Atlas OSS does not, through the postgres package; install postgres",
			)
		} finally {
			vi.doUnmock("postgres")
		}
	})
})

const facts = (sql: string) => historyFacts(extractSchema(sql, undefined, "postgres"), "app")
const FN = (name: string) => `CREATE FUNCTION ${name}() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`

/** A database's views, sequences and policies: none */
const noRelations = (): Pick<LiveObjects, "policies" | "relations"> => ({ policies: new Map(), relations: new Map() })

describe("liveDrift", () => {
	it("names what only one side has, keyed in the target schema, and counts what both have", () => {
		const history = facts(
			[
				'CREATE TABLE t ("id" int);',
				FN("f"),
				FN("app.g"),
				FN("other.h"),
				"CREATE TRIGGER t_ai AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();",
			].join("\n"),
		)
		const live = {
			...noRelations(),
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
		}
		expect(liveDrift(history, live)).toEqual({
			matched: { routines: 1, triggers: 1, views: 0 },
			only: [
				"function g(): only in the migrations",
				"procedure k(int4): only in the database",
				"trigger t_x on t (instead of delete or truncate, for each statement): only in the database",
			],
		})
	})

	it("is a match of kind as well as name", () => {
		const live = {
			...noRelations(),
			routines: new Map([["f", { kind: "procedure" as const, signatures: new Set([""]) }]]),
			triggers: new Map<string, Map<string, { enabled: boolean; type: number }>>(),
		}
		expect(liveDrift(facts(FN("f")), live).only).toEqual([
			"function f(): only in the migrations",
			"procedure f(): only in the database",
		])
	})

	/* Postgres keeps no array dimensions in a signature */
	it("reads a history's int[][] argument as the int4[] the catalog names", () => {
		const live = {
			...noRelations(),
			routines: new Map([["f", { kind: "function" as const, signatures: new Set(["int4[]"]) }]]),
			triggers: new Map<string, Map<string, { enabled: boolean; type: number }>>(),
		}
		const history = facts("CREATE FUNCTION f(a int[][]) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;")
		expect(liveDrift(history, live)).toEqual({ matched: { routines: 1, triggers: 0, views: 0 }, only: [] })
	})
})

/* the reviewer's reading of P13: two spellings the history and the catalog give one argument type differently */
/** A database holding function f with `signatures` */
const routine = (...signatures: string[]) => ({
	...noRelations(),
	routines: new Map([["f", { kind: "function" as const, signatures: new Set(signatures) }]]),
	triggers: new Map<string, Map<string, { enabled: boolean; type: number }>>(),
})

describe("liveDrift: an argument type spelled otherwise by the history", () => {
	it("matches a type the history leaves to the search path by its name, and a qualified one exactly", () => {
		const bare = facts("CREATE FUNCTION f(m mytype) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;")
		expect(liveDrift(bare, routine("public.mytype")).only).toEqual([])
		const qualified = facts("CREATE FUNCTION f(m other.mood) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;")
		expect(liveDrift(qualified, routine("elsewhere.mood")).only).toEqual([
			"function f(elsewhere.mood): only in the database",
			"function f(other.mood): only in the migrations",
		])
	})

	it("matches a %TYPE argument, which the catalog holds resolved, by its place, the arity still counted", () => {
		const typed = facts("CREATE FUNCTION f(e users.email%TYPE, n int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;")
		expect(liveDrift(typed, routine("text,int4")).only).toEqual([])
		expect(liveDrift(typed, routine("text")).only).toEqual([
			"function f(text): only in the database",
			"function f(users.email%TYPE,int4): only in the migrations",
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
					port: 6432,
					ssl: { checkServerIdentity: expect.any(Function), rejectUnauthorized: true },
					username: "app",
				},
			],
			[{ database: "app", host: "db", max: 1, port: 5432, ssl: false, username: "app" }],
		])
	})
})
