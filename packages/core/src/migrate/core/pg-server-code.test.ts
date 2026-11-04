/**
 * serverCode and targetCode (pg-server-code.ts): what a database holds of code, read once, which
 * decides where a run of files may share a session (comb-9d's rulings on PA1 of r22b); the query
 * is held to a real catalog in tests/integration/postgres/server-code.test.ts
 */
import { beforeAll, describe, expect, it } from "vitest"
import type { Connect } from "./pg-live-objects.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { NO_SERVER_CODE, SERVER_CODE, serverCode, targetCode, UNREAD } from "./pg-server-code.ts"

beforeAll(loadPostgresParser)

/* the code query's row for a database that holds no code */
const NONE = { events: false, names: [], opaque: false, reaches: [], sql: [], tables: [] }

const TARGET = { devUrl: "postgres://dev@h/d", lockTimeout: "5s", schema: "public", url: "postgres://u@h/t" }

/** A postgres.js stand-in answering the code query with `row`, or failing it; what it was given, sent and whether it ended */
function fake(row: Record<string, unknown> | Error) {
	const seen = { ended: 0, given: [] as Array<Record<string, unknown>>, sent: [] as string[] }
	const connect = ((options: Record<string, unknown>) => (
		seen.given.push(options),
		{
			end: async () => void seen.ended++,
			unsafe: async (query: string) => {
				seen.sent.push(query)
				if (row instanceof Error) throw row
				return [row]
			},
		}
	)) as Connect
	return { connect, seen }
}

describe("serverCode", () => {
	it("holds no code for a database with none, from one query", async () => {
		const { connect, seen } = fake(NONE)
		expect(await serverCode(connect({}))).toEqual(NO_SERVER_CODE)
		expect(seen.sent).toEqual([SERVER_CODE])
	})

	it("hands on the event trigger, the code no statement names, the names, the tables holding code and the pairs a flag carries along", async () => {
		const row = { ...NONE, events: true, names: ["op"], opaque: true, reaches: [["p", "q"]], tables: ["t"] }
		const { connect } = fake(row)
		expect(await serverCode(connect({}))).toEqual({
			...NO_SERVER_CODE,
			events: true,
			names: ["op"],
			opaque: true,
			reaches: [["p", "q"]],
			tables: ["t"],
		})
	})

	it("hands on each LANGUAGE sql definition as parsed, to be proven beside the directory's", async () => {
		const definition =
			"CREATE OR REPLACE FUNCTION public.f()\n RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT 1 $function$\n"
		const { connect } = fake({ ...NONE, sql: [definition] })
		const code = await serverCode(connect({}))
		expect([code.opaque, code.trees.length, JSON.stringify(code.trees).includes("CreateFunctionStmt")]).toEqual([
			false,
			1,
			true,
		])
	})

	it("takes a definition Postgres's parser cannot read for code", async () => {
		const { connect } = fake({ ...NONE, sql: ["CREATE FUNCTON f()"] })
		expect((await serverCode(connect({}))).opaque).toBe(true)
	})
})

/** A load of postgres.js without the postgres package */
const missing = async (): Promise<Connect> => {
	throw new Error("comb needs the postgres package")
}

describe("targetCode", () => {
	it("reads the target's own database, on one connection it ends", async () => {
		const { connect, seen } = fake(NONE)
		expect(await targetCode(TARGET, async () => connect)).toEqual(NO_SERVER_CODE)
		expect([seen.given.map((options) => options["database"]), seen.given[0]?.["max"], seen.ended]).toEqual([
			["t"],
			1,
			1,
		])
		/* a notice the query raises is dropped, not printed */
		expect(((seen.given[0] as Record<string, unknown>)["onnotice"] as () => unknown)()).toBeUndefined()
	})

	it("takes a target whose code it cannot read for code, the connection ended", async () => {
		const { connect, seen } = fake(new Error("permission denied"))
		expect(await targetCode(TARGET, async () => connect)).toEqual(UNREAD)
		expect(seen.ended).toBe(1)
	})

	it("takes code as held without the postgres package, so each file gets a call of its own", async () => {
		expect(await targetCode(TARGET, missing)).toEqual(UNREAD)
	})
})
