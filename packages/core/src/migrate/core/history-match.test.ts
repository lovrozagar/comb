import { describe, expect, it } from "vitest"
import { matchHistory, orphanMessage } from "./history-match.ts"
import { foldedMigrationHash, generateMigrationHash, migrationHashes, V0_5_0 } from "./parse.ts"

/** A file with its current hash and, after it, its pre-0.5.0 one */
const file = (name: string, current: string, legacy?: string) => ({
	hashes: [{ hash: current, until: Infinity }, ...(legacy === undefined ? [] : [{ hash: legacy, until: V0_5_0 }])],
	name,
})

/** A row recorded since 0.5.0, as every row the current comb writes is */
const NOW = Date.parse("2026-10-27T00:00:00Z")

/* M44: a file's pre-0.5.0 hash matches only a row recorded before 0.5.0, so an edit its normalizing hides is an edit */
describe("matchHistory: the legacy hash", () => {
	const before = Date.parse("2026-10-17T12:00:00Z")
	const after = Date.parse("2026-10-20T12:00:00Z")

	it("matches a named row by the file's legacy hash only when the row predates 0.5.0", () => {
		const files = [file("1.sql", "current", "legacy")]
		expect([...matchHistory(files, [{ createdAt: before, hash: "legacy", name: "1.sql" }], true).applied]).toEqual([
			"1.sql",
		])
		expect(matchHistory(files, [{ createdAt: after, hash: "legacy", name: "1.sql" }], true).edited).toEqual(["1.sql"])
	})

	it("matches an unnamed row by the legacy hash only when the row predates 0.5.0", () => {
		const files = [file("1.sql", "current", "legacy")]
		expect(matchHistory(files, [{ createdAt: before, hash: "legacy", name: null }], true).named).toEqual([
			{ hash: "legacy", name: "1.sql" },
		])
		expect(matchHistory(files, [{ createdAt: after, hash: "legacy", name: null }], true).orphans).toHaveLength(1)
	})
})

/* SL5 of r22 (sibling: the legacy hash): 0.5.0 to 0.20 folded every Unicode space, and no date tells which comb
   recorded a row, so a row of any date matches by the folded hash */
describe("matchHistory: the hash that folded every space", () => {
	const unicode = "CREATE TABLE t (id INTEGER PRIMARY KEY, a\u00a0b);"
	const ascii = "CREATE TABLE t (id INTEGER PRIMARY KEY, a b);"
	const later = Date.parse("2027-01-01T00:00:00Z")
	const files = [{ hashes: migrationHashes(unicode), name: "1.sql" }]

	it("matches a row of any date by the folded hash of the unchanged file", () => {
		const folded = foldedMigrationHash(unicode)
		const matched = matchHistory(files, [{ createdAt: later, hash: folded, name: "1.sql" }], true)
		expect([...matched.applied]).toEqual(["1.sql"])
		expect(matched.edited).toEqual([])
		expect(matchHistory(files, [{ createdAt: later, hash: folded, name: null }], true).named).toEqual([
			{ hash: folded, name: "1.sql" },
		])
	})

	it("names a file applied with such a space, then edited to a plain one, and takes the edit the other way", () => {
		const plain = [{ hashes: migrationHashes(ascii), name: "1.sql" }]
		const kept = [{ createdAt: later, hash: generateMigrationHash(unicode), name: "1.sql" }]
		expect(matchHistory(plain, kept, true).edited).toEqual(["1.sql"])
		expect(
			matchHistory(files, [{ createdAt: later, hash: generateMigrationHash(ascii), name: "1.sql" }], true).edited,
		).toEqual([])
	})
})

/* M45: a file applied with --file, then copied into the directory, would run again */
describe("matchHistory: a file whose text a --file row holds", () => {
	it("names each unapplied file a ../ row holds the text of, and never one a row records itself", () => {
		const rows = [
			{ createdAt: NOW, hash: "h", name: "../hotfix.sql" },
			{ createdAt: NOW, hash: "a", name: "1.sql" },
		]
		const matched = matchHistory([file("1.sql", "a"), file("2_hotfix.sql", "h")], rows, true)
		expect(matched.copies).toEqual([{ file: "2_hotfix.sql", row: "../hotfix.sql" }])
		expect(matchHistory([file("1.sql", "h")], [{ createdAt: NOW, hash: "h", name: "1.sql" }], true).copies).toEqual([])
	})
})

/* M15 and M16 of the 0.12 round: each row of the history records one file */
describe("matchHistory", () => {
	it("matches a named row by its name, and calls the file edited when its hash moved", () => {
		const matched = matchHistory(
			[file("1.sql", "a"), file("2.sql", "b2")],
			[
				{ createdAt: NOW, hash: "a", name: "1.sql" },
				{ createdAt: NOW, hash: "b", name: "2.sql" },
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
				{ createdAt: NOW, hash: "x", name: "2.sql" },
				{ createdAt: NOW, hash: "y", name: null },
			],
			true,
		)
		expect([...matched.applied].toSorted()).toEqual(["2.sql", "5.sql"])
		expect(matched.named).toEqual([{ hash: "y", name: "5.sql" }])
	})

	it("calls a row that matches no file an orphan over the whole directory, and nothing over one file", () => {
		const rows = [
			{ createdAt: NOW, hash: "a", name: "gone.sql" },
			{ createdAt: NOW, hash: "zzzzzzzzzzzzzzzz", name: null },
		]
		expect(matchHistory([file("1.sql", "b")], rows, true).orphans).toEqual(rows)
		expect(matchHistory([file("1.sql", "b")], rows, false).orphans).toEqual([])
	})

	it("leaves a row --file recorded from outside the directory out of the orphans", () => {
		const rows = [{ createdAt: NOW, hash: "a", name: "../lone.sql" }]
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
