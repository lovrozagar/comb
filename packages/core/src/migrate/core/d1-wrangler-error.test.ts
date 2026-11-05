import { describe, expect, it } from "vitest"
import { applyFailure, wranglerError } from "./d1-wrangler-error.ts"

const BUSY =
	"workerd/util/sqlite.c++:1733: failed: SQLite failed; dbErrorMessage(err, db) = database is locked: SQLITE_BUSY\n✘ [ERROR] internal error; reference = x1"
const LOCKED =
	"the local D1 database was locked by another process (wrangler dev, a wrangler command or a second comb migrate) while wrangler applied: let it finish and rerun"

describe("wranglerError", () => {
	it("keeps wrangler's [ERROR] lines without their colors, or its whole output when it printed none", () => {
		const colored = { stderr: "\u001b[1m⛅️ wrangler 4.0.0\u001b[0m\n\u001b[31m✘ [ERROR]\u001b[0m bad\n", stdout: "" }
		expect([wranglerError(colored), wranglerError({ stderr: " no lines \n", stdout: "" })]).toEqual([
			"✘ [ERROR] bad",
			"no lines",
		])
	})
})

describe("applyFailure", () => {
	it("names another process's lock on a local target, from either stream, and wrangler's error otherwise", () => {
		expect([
			applyFailure({ stderr: BUSY, stdout: "" }, true),
			applyFailure({ stderr: "", stdout: BUSY }, true),
			applyFailure({ stderr: BUSY, stdout: "" }, false),
			applyFailure({ stderr: "✘ [ERROR] Authentication error", stdout: "" }, true),
		]).toEqual([LOCKED, LOCKED, "✘ [ERROR] internal error; reference = x1", "✘ [ERROR] Authentication error"])
	})
})
