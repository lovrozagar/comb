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

/** The proof of each of `files` over a database `schema` made, on the scoped copy or the whole schema's */
async function proofsOf(schema: string, files: readonly string[], scoped: boolean): Promise<Proof[]> {
	const conn = libsqlConnection()
	open.push(conn)
	await conn.client.executeMultiple(schema)
	whole.on = !scoped
	const proofs = await provePending(
		conn,
		files.map((sql, i) => ({ name: `${i + 1}.sql`, sql })),
	)
	return [...proofs.values()]
}

/* 8.5 of plan 21: the bun:sqlite proof on the scoped copy finds what it finds on the whole schema's, and lists unproven
   only tables the whole copy lists */
describe("the bun:sqlite proof answers every corpus file on the scoped copy as on the whole schema's (8.5)", () => {
	it.each(scopeCorpus().map((each) => [each.label, each] as const))("%s", async (_, { files, schema }) => {
		const scoped = await proofsOf(schema, files, true)
		const all = await proofsOf(schema, files, false)
		expect(scoped.map(({ unproven: _unproven, ...verdict }) => verdict)).toEqual(
			all.map(({ unproven: _unproven, ...verdict }) => verdict),
		)
		for (const [i, { unproven }] of scoped.entries()) expect(all[i]?.unproven).toEqual(expect.arrayContaining(unproven))
	})
})
