import { describe, expect, it } from "vitest"
import { matchHistory, orphanMessage } from "./history-match.ts"

const file = (name: string, ...hashes: string[]) => ({ hashes, name })

/* M15 and M16 of the 0.12 round: each row of the history records one file */
describe("matchHistory", () => {
	it("matches a named row by its name, and calls the file edited when its hash moved", () => {
		const matched = matchHistory(
			[file("1.sql", "a"), file("2.sql", "b2")],
			[
				{ hash: "a", name: "1.sql" },
				{ hash: "b", name: "2.sql" },
			],
			true,
		)
		expect([...matched.applied]).toEqual(["1.sql"])
		expect(matched.edited).toEqual(["2.sql"])
	})

	it("matches an unnamed row to one file by hash, never one a named row holds, and names it", () => {
		const matched = matchHistory(
			[file("2.sql", "x"), file("4.sql", "x"), file("5.sql", "y")],
			[
				{ hash: "x", name: "2.sql" },
				{ hash: "y", name: null },
			],
			true,
		)
		expect([...matched.applied].toSorted()).toEqual(["2.sql", "5.sql"])
		expect(matched.named).toEqual([{ hash: "y", name: "5.sql" }])
	})

	it("calls a row that matches no file an orphan over the whole directory, and nothing over one file", () => {
		const rows = [
			{ hash: "a", name: "gone.sql" },
			{ hash: "zzzzzzzzzzzzzzzz", name: null },
		]
		expect(matchHistory([file("1.sql", "b")], rows, true).orphans).toEqual(rows)
		expect(matchHistory([file("1.sql", "b")], rows, false).orphans).toEqual([])
	})

	it("leaves a row --file recorded from outside the directory out of the orphans", () => {
		const rows = [{ hash: "a", name: "../lone.sql" }]
		expect(matchHistory([file("1.sql", "b")], rows, true).orphans).toEqual([])
	})

	it("names each orphan, by name or its hash's start, in its message", () => {
		expect(orphanMessage([{ hash: "a", name: "2.sql" }], "m")).toBe(
			"1 applied migration matches no file in m (2.sql): one was edited or renamed after it was applied; restore it, or record the change in a new file",
		)
		expect(
			orphanMessage(
				[
					{ hash: "a", name: "2.sql" },
					{ hash: "0123456789abcdef", name: null },
				],
				"m",
			),
		).toMatch(/^2 applied migrations match no file in m \(2\.sql, 0123456789ab\)/)
	})
})
