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
	async () => ({ code, stderr, stdout })

describe("atlasStatus: Atlas's status of the snapshot", () => {
	it("reads Atlas's JSON, and reads a database Atlas calls not clean as having no history only when asked", async () => {
		const status = { applied: [], available: [], current: "1", error: "", pending: [], status: "OK" }
		expect(await atlasStatus({ dir: "", exec: answering(0, JSON.stringify(status)), print, target }, "/copy")).toEqual(
			status,
		)
		const notClean = answering(1, "", "Error: sql/migrate: connected database is not clean: found table")
		expect(await atlasStatus({ dir: "", exec: notClean, print, target }, "/copy", { notClean: true })).toBe(NO_HISTORY)
		await expect(atlasStatus({ dir: "", exec: notClean, print, target }, "/copy")).rejects.toThrow(
			/^atlas migrate status: the database has objects but no migration history/,
		)
		/* K6 of r21: what Atlas said is quoted without its trailing newline */
		await expect(
			atlasStatus({ dir: "", exec: answering(1, "", "Error: boom\n"), print, target }, "/copy"),
		).rejects.toThrow(new Error("atlas migrate status: Error: boom"))
		await expect(atlasStatus({ dir: "", exec: answering(2, "out\n"), print, target }, "/copy")).rejects.toThrow(
			new Error("atlas migrate status: exit 2: out"),
		)
	})

	it("refuses output it cannot read without repeating it", () => {
		expect(() => json("{ secret", "status")).toThrow(/^unexpected output from atlas migrate status$/)
	})

	/* M79: Atlas's words are matched as Atlas wrote them, so a password that spells one changes nothing */
	it("reads a database Atlas calls not clean as having no history whatever the password spells", async () => {
		const notClean = answering(1, "", "Error: sql/migrate: connected database is not clean: found table")
		for (const password of ["clean", "database", "connected"]) {
			const secret = { ...target, url: `postgres://app:${password}@localhost/app` }
			expect(await atlasStatus({ dir: "", exec: notClean, print, target: secret }, "/copy", { notClean: true })).toBe(
				NO_HISTORY,
			)
		}
	})
})
