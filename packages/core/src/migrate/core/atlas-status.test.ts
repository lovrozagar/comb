import { describe, expect, it } from "vitest"
import { atlasStatus, json, NO_HISTORY } from "./atlas-status.ts"
import type { Run } from "./process.ts"

const target = {
	devUrl: "postgres://localhost/dev",
	lockTimeout: "5s",
	schema: "public",
	url: "postgres://localhost/app",
}
const print = () => undefined
const answering =
	(code: number, stdout: string, stderr = ""): Run =>
	() => ({ code, stderr, stdout })

describe("atlasStatus: Atlas's status of the snapshot", () => {
	it("reads Atlas's JSON, and reads a database Atlas calls not clean as having no history only when asked", () => {
		const status = { applied: [], available: [], current: "1", error: "", pending: [], status: "OK" }
		expect(atlasStatus({ dir: "", exec: answering(0, JSON.stringify(status)), print, target }, "/copy")).toEqual(status)
		const notClean = answering(1, "", "Error: sql/migrate: connected database is not clean: found table")
		expect(atlasStatus({ dir: "", exec: notClean, print, target }, "/copy", { notClean: true })).toBe(NO_HISTORY)
		expect(() => atlasStatus({ dir: "", exec: notClean, print, target }, "/copy")).toThrow(
			/^atlas migrate status: the database has objects but no migration history/,
		)
		expect(() => atlasStatus({ dir: "", exec: answering(2, "out"), print, target }, "/copy")).toThrow(
			"atlas migrate status: exit 2: out",
		)
	})

	it("refuses output it cannot read without repeating it", () => {
		expect(() => json("{ secret", "status")).toThrow(/^unexpected output from atlas migrate status$/)
	})
})
