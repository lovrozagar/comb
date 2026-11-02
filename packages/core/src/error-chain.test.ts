import { describe, expect, it } from "vitest"
import { causeChain, errorTexts, innermostFirst } from "./error-chain.ts"

/* K1 of r19: drizzle keeps SQLite's own words only on its DrizzleQueryError's cause */
const wrapped = new Error("Failed query: SELECT 1", {
	cause: Object.assign(new Error("SQLITE_ERROR: no such function: editdist3"), { code: "SQLITE_ERROR" }),
})

describe("causeChain", () => {
	it("walks `.cause` outermost first, through objects that are no Error, and stops at a value", () => {
		const inner = { message: "inner" }
		const outer = new Error("outer", { cause: inner })
		expect(causeChain(outer)).toEqual([outer, inner])
		expect(causeChain(new Error("alone", { cause: "a string" }))).toHaveLength(1)
		expect(causeChain("text")).toEqual([])
		expect(causeChain(null)).toEqual([])
	})

	it("reads at most eight links, so a cycle ends", () => {
		const cyclic: { cause?: unknown } = {}
		cyclic.cause = cyclic
		expect(causeChain(cyclic)).toHaveLength(8)
	})
})

describe("errorTexts", () => {
	it("gives each link's message and string code, outermost first", () => {
		expect(errorTexts(wrapped)).toEqual([
			"Failed query: SELECT 1",
			"SQLITE_ERROR: no such function: editdist3",
			"SQLITE_ERROR",
		])
	})

	it("gives a thrown string as itself, and skips a code that is no string", () => {
		expect(errorTexts("no such function: editdist3")).toEqual(["no such function: editdist3"])
		expect(errorTexts(Object.assign(new Error("m"), { code: 5 }))).toEqual(["m"])
	})
})

describe("innermostFirst", () => {
	it("gives the chain innermost first, as a copy", () => {
		const chain = causeChain(wrapped)
		expect(innermostFirst(chain)).toEqual([wrapped.cause, wrapped])
		expect(chain).toEqual([wrapped, wrapped.cause])
	})
})
