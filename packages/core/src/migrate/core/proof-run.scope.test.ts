import { afterEach, describe, expect, it, vi } from "vitest"
import { libsqlConnection, type LibsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { scopeCorpus } from "../__fixtures__/scope-corpus.ts"
import { type Proof, provePending } from "./proof-run.ts"
import { asciiFold } from "./sql-code.ts"

vi.mock("bun:sqlite", () => import("../__fixtures__/bun-sqlite-node.ts"))

/* the whole schema's copy: observable answering every object created and every table seeded, as before 8.5 */
const whole = vi.hoisted(() => ({ on: false }))
vi.mock("./proof-scope.ts", async (original) => {
	const real = await original<typeof import("./proof-scope.ts")>()
	return {
		...real,
		observable: (...args: Parameters<typeof real.observable>) => {
			const [objects] = args
			if (!whole.on) return real.observable(...args)
			const tables = objects.filter((object) => object.type === "table")
			return { objects: [...objects], seeded: new Set(tables.map((object) => asciiFold(object.name))) }
		},
	}
})

const open: LibsqlConnection[] = []
afterEach(async () => {
	whole.on = false
	for (const conn of open.splice(0)) await conn.close()
})

/** The proof of `file` over a database `schema` made, on the scoped copy or the whole schema's */
async function proofOf(schema: string, file: string, scoped: boolean): Promise<Proof> {
	const conn = libsqlConnection()
	open.push(conn)
	await conn.client.executeMultiple(schema)
	whole.on = !scoped
	const proofs = await provePending(conn, [{ name: "1.sql", sql: file }])
	return proofs.get("1.sql") as Proof
}

/* 8.5 of plan 21: the bun:sqlite proof on the scoped copy finds what it finds on the whole schema's, and lists unproven
   only tables the whole copy lists */
describe("the bun:sqlite proof answers every corpus file on the scoped copy as on the whole schema's (8.5)", () => {
	it.each(scopeCorpus().map((each) => [each.label, each] as const))("%s", async (_, { file, schema }) => {
		const scoped = await proofOf(schema, file, true)
		const all = await proofOf(schema, file, false)
		const { unproven, ...verdict } = scoped
		const { unproven: allUnproven, ...wholeVerdict } = all
		expect(verdict).toEqual(wholeVerdict)
		expect(allUnproven).toEqual(expect.arrayContaining(unproven))
	})
})
