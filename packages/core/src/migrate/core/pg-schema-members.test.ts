import { describe, expect, it } from "vitest"
import { holdsAnything } from "./pg-schema-members.ts"

/** A postgres.js answering each query with `rows`, or failing it with `fails`, recording what it saw */
function fakeConnect(rows: Array<Record<string, unknown>>, fails?: Error) {
	const seen = { ended: false, params: [] as unknown[][], urls: [] as unknown[] }
	const connect = (options: Record<string, unknown>) => {
		seen.urls.push(options["database"])
		return {
			end: async () => void (seen.ended = true),
			unsafe: async (_query: string, params: unknown[]) => {
				seen.params.push(params)
				if (fails !== undefined) throw fails
				return rows
			},
		}
	}
	return { load: async () => connect, seen }
}

const target = { schema: "App", url: "postgres://app:App-Secret-0451@localhost/target" }

/* PA6 of r22b: every object of every kind in a schema depends on it in pg_depend */
describe("holdsAnything", () => {
	it("reads the schema named exactly on the target database, and closes the connection", async () => {
		const { load, seen } = fakeConnect([{ held: true }])
		expect(await holdsAnything(target, load)).toBe(true)
		expect(seen).toEqual({ ended: true, params: [["App"]], urls: ["target"] })
	})

	it("is false when nothing depends on the schema", async () => {
		expect(await holdsAnything(target, fakeConnect([{ held: false }]).load)).toBe(false)
	})

	it("refuses, naming the schema and the password masked, when the read fails", async () => {
		const { load, seen } = fakeConnect([], new Error("password authentication failed for App-Secret-0451"))
		const refused = holdsAnything(target, load)
		await expect(refused).rejects.toThrow(/^comb could not read what schema App holds: password authentication failed/)
		await expect(refused).rejects.not.toThrow("App-Secret-0451")
		expect(seen.ended).toBe(true)
	})
})
