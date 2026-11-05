/**
 * The scope reader follows a Postgres file's own BEGIN: a txmode none file commits each statement
 * outside it, and the locks a NOT VALID ADD took end with that commit (PA8 of r22b), while a file
 * Atlas runs in one transaction holds them to its end.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { scopeReader } from "./pg-scope.ts"
import { pgRead } from "./pg-split.ts"
import { type Held, heldStart } from "./pg-held.ts"

beforeAll(loadPostgresParser)

/** The tables still held after each statement of `sql`, read as a file outside a transaction when `bare` */
function heldAfter(sql: string, bare: boolean): string[][] {
	const held: Held = heldStart()
	const read = scopeReader(bare, { facts: historyFacts(undefined, "public"), held })
	return pgRead(sql).statements.map(({ tree }, i) => {
		read(tree)
		held.locks.set(`t${i}`, false)
		return [...held.locks.keys()]
	})
}

const SQL = "SELECT 1;\nBEGIN;\nSELECT 2;\nSELECT 3;\nCOMMIT;\nSELECT 4;\n"

describe("scopeReader: the locks a file holds, by where its statements commit (PA8; sibling: one transaction)", () => {
	it("lets go of them at each statement a txmode none file commits, and holds them inside its own BEGIN", () => {
		expect(heldAfter(SQL, true)).toEqual([
			["t0"],
			["t1"],
			["t1", "t2"],
			["t1", "t2", "t3"],
			["t1", "t2", "t3", "t4"],
			["t5"],
		])
	})

	it("holds them to the end of a file Atlas runs in one transaction", () => {
		expect(heldAfter(SQL, false).at(-1)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5"])
	})

	it("reads a statement Postgres runs only outside a transaction, and one it runs only inside a block", () => {
		const read = scopeReader(true, { facts: historyFacts(undefined, "public"), held: heldStart() })
		const [vacuum, savepoint] = pgRead("VACUUM t;\nSAVEPOINT s;\n").statements.map(({ tree }) => read(tree))
		expect({ savepoint: savepoint?.inside !== undefined, vacuum: vacuum?.outside !== undefined }).toEqual({
			savepoint: true,
			vacuum: true,
		})
	})
})
