import { describe, expect, it } from "vitest"
import { LOCAL_BUSY, lockedOut } from "./d1-lock.ts"

describe("LOCAL_BUSY", () => {
	it("matches workerd's busy line, plain or colored, and no other SQLite code or sense of locked", () => {
		const line = "dbErrorMessage(err, db) = database is locked: SQLITE_BUSY stack: 7f0a"
		const others = [
			"database is locked: SQLITE_BUSY_SNAPSHOT",
			"database is locked: SQLITE_LOCKED",
			"database table is locked: SQLITE_LOCKED_SHAREDCACHE",
			"the account is locked: contact support",
		]
		expect([line, `\u001b[31m${line}\u001b[0m`, ...others].map((text) => LOCAL_BUSY.test(text))).toEqual([
			true,
			true,
			false,
			false,
			false,
			false,
		])
	})
})

/* CI on 84332342: wrangler's answer names only an internal error, and workerd's line can come too late */
describe("lockedOut", () => {
	const line = "dbErrorMessage(err, db) = database is locked: SQLITE_BUSY"
	it("reads workerd's line from either stream without asking SQLite, and SQLite's answer without it", async () => {
		const asked: string[] = []
		const held = (answer: boolean, name: string) => async () => {
			asked.push(name)
			return answer
		}
		expect([
			await lockedOut({ stderr: line, stdout: "" }, held(false, "stderr")),
			await lockedOut({ stderr: "", stdout: line }, held(false, "stdout")),
			await lockedOut({ stderr: "", stdout: "internal error" }, held(true, "held")),
			await lockedOut({ stderr: "", stdout: "internal error" }, held(false, "free")),
		]).toEqual([true, true, true, false])
		expect(asked).toEqual(["held", "free"])
	})
})
