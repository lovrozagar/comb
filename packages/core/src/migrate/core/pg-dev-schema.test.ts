import { describe, expect, it, vi } from "vitest"
import { ReplayFailed } from "./baseline-compare.ts"
import { readyDevSchema } from "./pg-dev-schema.ts"

/** A postgres.js that records each query and its connection's end, `fails` failing the query */
function fakeConnect(fails?: Error) {
	const seen: { ended: boolean; queries: string[]; urls: string[] } = { ended: false, queries: [], urls: [] }
	const connect = (url: string) => {
		seen.urls.push(url)
		return {
			end: async () => void (seen.ended = true),
			unsafe: async (query: string) => {
				seen.queries.push(query)
				if (fails !== undefined) throw fails
				return []
			},
		}
	}
	return { load: async () => connect, seen }
}

const target = (schema: string, devUrl = "postgres://dev:Dev-Secret-0451@localhost/dev") => ({
	devUrl,
	lockTimeout: "5s",
	schema,
	url: "",
})

/* P12 of the 0.14.1 review: Atlas inspects the schema its dev URL is scoped to before it replays anything */
describe("readyDevSchema", () => {
	it("creates the schema on the dev database, its name quoted, and closes the connection", async () => {
		const { load, seen } = fakeConnect()
		await readyDevSchema(target('app"x'), load)
		expect(seen).toEqual({
			ended: true,
			queries: ['CREATE SCHEMA IF NOT EXISTS "app""x"'],
			urls: ["postgres://dev:Dev-Secret-0451@localhost/dev"],
		})
	})

	it("leaves public, and Atlas's own docker container, alone", async () => {
		const { load, seen } = fakeConnect()
		await readyDevSchema(target("public"), load)
		await readyDevSchema(target("app", "docker://postgres/17/dev"), load)
		expect(seen.urls).toEqual([])
	})

	it("refuses, naming devUrl and its password masked, when the schema cannot be created", async () => {
		const { load, seen } = fakeConnect(new Error("password authentication failed for Dev-Secret-0451"))
		const refused = readyDevSchema(target("app"), load)
		await expect(refused).rejects.toBeInstanceOf(ReplayFailed)
		await expect(refused).rejects.toThrow(
			/^comb could not create schema app on devUrl, where Atlas replays the migrations: /,
		)
		await expect(refused).rejects.not.toThrow("Dev-Secret-0451")
		expect(seen.ended).toBe(true)
	})

	it("refuses, naming the peer and why, when postgres.js is missing", async () => {
		vi.doMock("postgres", () => {
			throw new Error("Cannot find package 'postgres'")
		})
		vi.resetModules()
		try {
			const { readyDevSchema: fresh } = await import("./pg-dev-schema.ts")
			await expect(fresh(target("app"))).rejects.toThrow(
				"a non-public schema needs the `postgres` package to create it on devUrl; install postgres (>=3.4.9 <4), an optional peer, and run it again",
			)
		} finally {
			vi.doUnmock("postgres")
		}
	})
})
