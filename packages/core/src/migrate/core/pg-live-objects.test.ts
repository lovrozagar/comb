import { describe, expect, it, vi } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { liveDrift, loadPostgres, readLiveObjects } from "./pg-live-objects.ts"
import { extractSchema } from "./schema.ts"

const TARGET = { devUrl: "postgres://dev/x", lockTimeout: "5s", schema: "app", url: "postgres://app:s3cret@db/app" }

/** A postgres.js stand-in answering `rows`, or failing with `error`; what it was asked */
function fakeConnect(answer: { error?: Error; rows?: Array<Record<string, unknown>> }) {
	const seen = { ended: false, params: [] as unknown[], url: "" }
	const connect = (url: string) => {
		seen.url = url
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
	it("reads each routine's overloads and each table's triggers in the target schema, and closes the connection", async () => {
		const { load, seen } = fakeConnect({
			rows: [
				{ kind: "function", name: "f", on_table: null, signature: "", what: "routine" },
				{ kind: "function", name: "f", on_table: null, signature: "int4,text[]", what: "routine" },
				{ kind: "procedure", name: "p", on_table: null, signature: "other.mood", what: "routine" },
				{ enabled: true, name: "t_ai", on_table: "t", tgtype: 5, what: "trigger" },
				{ enabled: false, name: "t_bu", on_table: "t", tgtype: 19, what: "trigger" },
			],
		})
		expect(await readLiveObjects(TARGET, load)).toEqual({
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
		expect(seen).toEqual({ ended: true, params: ["app"], url: TARGET.url })
	})

	it("says why it could not read, with the password masked, and closes the connection still", async () => {
		const { load, seen } = fakeConnect({ error: new Error("password authentication failed for s3cret") })
		await expect(readLiveObjects(TARGET, load)).rejects.toThrow(
			/^comb could not read the database's functions and triggers: password authentication failed for (?!s3cret)/,
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
				"baseline compares the database's functions and triggers, which Atlas OSS does not, through the postgres package; install postgres",
			)
		} finally {
			vi.doUnmock("postgres")
		}
	})
})

const facts = (sql: string) => historyFacts(extractSchema(sql, undefined, "postgres"), "app")
const FN = (name: string) => `CREATE FUNCTION ${name}() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`

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
			matched: { routines: 1, triggers: 1 },
			only: [
				"function g(): only in the migrations",
				"procedure k(int4): only in the database",
				"trigger t_x on t (instead of delete or truncate, for each statement): only in the database",
			],
		})
	})

	it("is a match of kind as well as name", () => {
		const live = {
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
			routines: new Map([["f", { kind: "function" as const, signatures: new Set(["int4[]"]) }]]),
			triggers: new Map<string, Map<string, { enabled: boolean; type: number }>>(),
		}
		const history = facts("CREATE FUNCTION f(a int[][]) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;")
		expect(liveDrift(history, live)).toEqual({ matched: { routines: 1, triggers: 0 }, only: [] })
	})
})

/* the reviewer's reading of P13: two spellings the history and the catalog give one argument type differently */
/** A database holding function f with `signatures` */
const routine = (...signatures: string[]) => ({
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
})
