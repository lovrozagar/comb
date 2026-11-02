import { describe, expect, it } from "vitest"
import { isTransient } from "./transient.ts"

/** An error carrying the HTTP status `code`, as hrana's HttpServerError does */
const httpStatus = (code: number) => Object.assign(new Error(`HTTP ${code}`), { status: code })
/** An error carrying the network code `code`, as Node's and undici's do */
const network = (code: string) => Object.assign(new Error("socket hang up"), { code })

/* S7 of the 0.15.0 review: transience is read from codes and statuses, the error's or its causes' */
describe("isTransient", () => {
	it.each([
		["an HTTP 429", httpStatus(429)],
		["an HTTP 503", httpStatus(503)],
		[
			"libsql's wrap of a 429",
			Object.assign(new Error("server error"), { cause: httpStatus(429), code: "SERVER_ERROR" }),
		],
		["undici's fetch failed over a reset", new TypeError("fetch failed", { cause: network("ECONNRESET") })],
		["a timed-out connection", network("ETIMEDOUT")],
		["a socket undici closed", network("UND_ERR_SOCKET")],
	] as Array<[string, Error]>)("holds %s transient", (_, error) => {
		expect(isTransient(error)).toBe(true)
	})

	it.each([
		[
			"a SQLite error quoting 429",
			Object.assign(new Error("UNIQUE constraint failed: t429.body"), { code: "SQLITE_CONSTRAINT" }),
		],
		[
			"a SQLite error caused by a 503",
			Object.assign(new Error("x"), { cause: httpStatus(503), code: "SQLITE_BUSY_X" }),
		],
		["prose that names a rate limit", new Error("429 rate limit ECONNRESET fetch failed")],
		["an HTTP 404", httpStatus(404)],
		["a cause that is no object", new Error("x", { cause: "ECONNRESET" })],
		["a thrown string", "ECONNRESET"],
		["null", null],
	])("holds %s not transient", (_, error) => {
		expect(isTransient(error)).toBe(false)
	})
})
