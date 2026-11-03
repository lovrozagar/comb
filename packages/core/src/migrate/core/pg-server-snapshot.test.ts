import { describe, expect, it } from "vitest"
import { added, type Snapshot, snapshotChanges } from "./pg-server-snapshot.ts"

/** A snapshot of `rows`: each subject, the names its row is about, and the row */
const at = (rows: Array<[string, string[], Record<string, unknown>]>): Snapshot =>
	new Map(rows.map(([subject, names, row]) => [subject, { names, row }]))

/* P2 of r22: a change past the replay's database is the file's only when it names a name the file spells */
describe("snapshotChanges and added", () => {
	const before = at([
		["role kept", ["kept"], { rolconnlimit: -1 }],
		["role gone", ["gone"], {}],
		["database theirs", ["theirs"], { datconnlimit: -1 }],
	])
	const after = at([
		["role kept", ["kept"], { rolconnlimit: 5 }],
		["role svc", ["svc"], {}],
		["role other", ["other"], {}],
		["database Big", ["Big"], {}],
		["database theirs", ["theirs"], { datconnlimit: 3 }],
		["membership svc to kept by me", ["svc", "kept"], {}],
		["replication slot feed", ["feed"], { type: "physical" }],
	])

	it("names every change, in order, without names to attribute by", () => {
		expect(snapshotChanges(before, after)).toEqual([
			"database Big added",
			"database theirs changed (datconnlimit)",
			"membership svc to kept by me added",
			"replication slot feed added",
			"role gone removed",
			"role kept changed (rolconnlimit)",
			"role other added",
			"role svc added",
		])
	})

	it("keeps only the changes to a subject the file names, by any of its names", () => {
		const names = new Set(["svc", "gone", "Big", "feed"])
		expect(snapshotChanges(before, after, names)).toEqual([
			"database Big added",
			"membership svc to kept by me added",
			"replication slot feed added",
			"role gone removed",
			"role svc added",
		])
		expect(added(before, after, names)).toEqual({ databases: ["Big"], roles: ["svc"], slots: ["feed"] })
	})
})
