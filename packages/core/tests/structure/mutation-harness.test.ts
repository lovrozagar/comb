import { describe, expect, it } from "vitest"
import { GUARDS, guardNamed, runSuite, suiteRun, survivors } from "./mutation-harness.ts"

describe("the guard registry", () => {
	it("names each guard once, with the module it lives in", () => {
		const ids = GUARDS.map((g) => g.id)
		expect(new Set(ids).size).toBe(ids.length)
		expect(guardNamed("raw-sql-quoting")).toMatchObject({ module: "src/query/sqlite/identifier.ts" })
	})

	it("runs the plain suite when no mutant is named", () => {
		expect(guardNamed(undefined)).toBeUndefined()
		expect(guardNamed("")).toBeUndefined()
	})

	it("refuses a mutant it does not know, so a typo never runs the plain suite", () => {
		expect(() => guardNamed("raw-sql-quotng")).toThrow(/unknown guard "raw-sql-quotng"/)
	})
})

describe("survivors", () => {
	it("lists the guards whose removal left the suite green", () => {
		expect(
			survivors([
				{ id: "a", status: 1 },
				{ id: "b", status: 0 },
			]),
		).toEqual(["b"])
	})
})

describe("the adversarial suite against each guard", () => {
	it("passes with every guard in place", () => {
		/* a failure names what the nested run printed, so it is never a bare exit code */
		const run = suiteRun(undefined)
		expect(run.status, run.output).toBe(0)
	}, 120_000)

	it.each(GUARDS.map((g) => g.id))(
		"goes red with the %s guard disabled",
		(id) => {
			expect(runSuite(id)).not.toBe(0)
		},
		120_000,
	)
})
