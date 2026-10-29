import { describe, expect, it } from "vitest"
import { classifyPgError } from "./error-handler.ts"

/* Q14 of r17: each driver's own words for a connection refused or lost, as the drivers were seen to throw them */
/** An error as a driver throws it: its message, and its code when it has one */
const driver = (code: string | undefined, message: string) =>
	Object.assign(new Error(message), code === undefined ? {} : { code })

describe("classifyPgError on a lost connection", () => {
	it.each([
		["postgres.js and pg, refused", driver("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1")],
		["postgres.js, reset", driver("ECONNRESET", "read ECONNRESET")],
		["a timeout", driver("ETIMEDOUT", "connect ETIMEDOUT")],
		["a broken pipe", driver("EPIPE", "write EPIPE")],
		["postgres.js, closed", driver("CONNECTION_CLOSED", "write CONNECTION_CLOSED 127.0.0.1:5432")],
		["postgres.js, connect timeout", driver("CONNECT_TIMEOUT", "write CONNECT_TIMEOUT 127.0.0.1:5432")],
		["Bun.SQL, refused", driver("ERR_POSTGRES_CONNECTION_REFUSED", "Failed to connect")],
		["pg, its client broken", driver(undefined, "Client has encountered a connection error and is not queryable")],
		/* R2 of plan 16's review: the rest of the class, as pg 8.23, pg-pool and Bun.SQL throw it */
		["pg, the connection dropped under a query", driver(undefined, "Connection terminated unexpectedly")],
		["pg, a connect timeout", driver(undefined, "timeout expired")],
		[
			"pg-pool, a connect timeout",
			Object.assign(new Error("Connection terminated due to connection timeout"), { cause: new Error("x") }),
		],
		["pg-pool, exhausted", driver(undefined, "timeout exceeded when trying to connect")],
		["Bun.SQL, idle timeout", driver("ERR_POSTGRES_IDLE_TIMEOUT", "Idle timeout reached")],
		["Bun.SQL, lifetime timeout", driver("ERR_POSTGRES_LIFETIME_TIMEOUT", "Max lifetime timeout reached")],
		["a host unreachable", driver("EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.1:5432")],
		["a network unreachable", driver("ENETUNREACH", "connect ENETUNREACH 10.0.0.1:5432")],
		["a DNS lookup to retry", driver("EAI_AGAIN", "getaddrinfo EAI_AGAIN db")],
	])("answers %s as database_unavailable 503", (_label, error) => {
		expect(classifyPgError(error, [])).toMatchObject({ errorKey: "database_unavailable", status: 503 })
	})

	it("answers an error of no driver's connection words as nothing", () => {
		expect(classifyPgError(driver("ENOENT", "no such file"), [])).toBeUndefined()
		expect(classifyPgError(driver(undefined, "connection error"), [])).toBeUndefined()
		/* the app's own doing, or a host that does not exist: a 500 to fix, not a 503 to retry */
		for (const message of ["Client was closed and is not queryable", "Connection terminated", "Query read timeout"])
			expect(classifyPgError(driver(undefined, message), [])).toBeUndefined()
		expect(classifyPgError(driver("ENOTFOUND", "getaddrinfo ENOTFOUND db"), [])).toBeUndefined()
	})
})
