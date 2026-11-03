import { describe, expect, it } from "vitest"
import type { Finding } from "./classify-alter.ts"
import { classificationOf, type Read } from "./classify-verdict.ts"

/** A Postgres statement read with `findings`, and what it is when it runs only outside a transaction */
const read = (stmt: string, findings: Finding[], outside?: string): Read => ({
	code: stmt,
	dialect: "postgres",
	findings,
	outside,
	stmt,
})

describe("classificationOf", () => {
	it("lists a statement once, at the strictest level its readings give it, with each note once", () => {
		const reads = [
			read("DROP TABLE a", [
				{ level: "cautious", note: "n" },
				{ level: "unsafe", note: "drops a" },
				{ level: "unsafe", note: "drops a" },
			]),
			read("CREATE INDEX i ON t (a)", [{ level: "lock" }, { level: "cautious", pending: true }]),
		]
		expect(classificationOf(reads, "")).toEqual({
			cautiousStatements: ["CREATE INDEX i ON t (a)"],
			lockWarnings: ["CREATE INDEX i ON t (a)"],
			pendingStatements: ["CREATE INDEX i ON t (a)"],
			safety: "unsafe",
			unsafeStatements: ["DROP TABLE a (drops a)"],
		})
	})

	it("rates a file Atlas runs outside a transaction cautious, and nothing found safe", () => {
		expect(classificationOf([], "-- atlas:txmode none\n\nSELECT 1;").safety).toBe("cautious")
		expect(classificationOf([read("SELECT 1", [])], "SELECT 1;").safety).toBe("safe")
	})

	it("refuses a statement Postgres runs only outside a transaction in a file that runs in one", () => {
		const reads = [read("CLUSTER p USING p_at", [], "CLUSTER")]
		expect(() => classificationOf(reads, "CLUSTER p USING p_at;")).toThrow(
			"Postgres runs CLUSTER only outside a transaction",
		)
		expect(classificationOf(reads, "-- atlas:txmode none\n\nCLUSTER p USING p_at;").safety).toBe("cautious")
	})
})
