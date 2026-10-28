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
	it("reads each routine's kind and each table's triggers in the target schema, and closes the connection", async () => {
		const { load, seen } = fakeConnect({
			rows: [
				{ kind: "function", name: "f", on_table: null, what: "routine" },
				{ kind: "procedure", name: "p", on_table: null, what: "routine" },
				{ kind: null, name: "t_ai", on_table: "t", what: "trigger" },
				{ kind: null, name: "t_bu", on_table: "t", what: "trigger" },
			],
		})
		expect(await readLiveObjects(TARGET, load)).toEqual({
			routines: new Map([
				["f", "function"],
				["p", "procedure"],
			]),
			triggers: new Map([["t", new Set(["t_ai", "t_bu"])]]),
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
		expect(typeof (await loadPostgres())).toBe("function")
	})

	it("refuses, naming the package and its range, when the peer is missing", async () => {
		vi.doMock("postgres", () => {
			throw new Error("Cannot find package 'postgres'")
		})
		vi.resetModules()
		try {
			const { loadPostgres: missing } = await import("./pg-live-objects.ts")
			await expect(missing()).rejects.toThrow(
				"baseline compares the database's functions and triggers, which Atlas OSS does not, through the postgres package; install postgres (>=3.4.9 <4), an optional peer, and run it again",
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
				["f", "function" as const],
				["k", "procedure" as const],
			]),
			triggers: new Map([["t", new Set(["t_ai", "t_x"])]]),
		}
		expect(liveDrift(history, live)).toEqual({
			matched: 2,
			only: [
				"function g: only in the migrations",
				"procedure k: only in the database",
				"trigger t_x on t: only in the database",
			],
		})
	})

	it("is a match of kind as well as name", () => {
		const live = { routines: new Map([["f", "procedure" as const]]), triggers: new Map<string, Set<string>>() }
		expect(liveDrift(facts(FN("f")), live).only).toEqual([
			"function f: only in the migrations",
			"procedure f: only in the database",
		])
	})
})
