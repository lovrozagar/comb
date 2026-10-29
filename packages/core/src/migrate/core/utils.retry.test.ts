import { describe, expect, it, vi } from "vitest"
import {
	aggregateErrors,
	checkCircuitBreaker,
	createCircuitBreaker,
	dropsQuestion,
	printMigrationSummary,
	sleep,
	updateCircuitBreaker,
	withRetry,
} from "./utils.ts"
import type { MigrationResult } from "../types.ts"

/* Retries back off in real time; a fake timer keeps the suite fast without
   weakening the assertions about how many attempts were made. */
const fast = { baseDelay: 0, maxDelay: 0 }

describe("sleep", () => {
	it("resolves after the requested delay", async () => {
		const started = Date.now()
		await sleep(5)
		expect(Date.now() - started).toBeGreaterThanOrEqual(4)
	})
})

/** An error carrying the HTTP status `code`, as hrana's HttpServerError does */
const httpStatus = (code: number) => Object.assign(new Error(`HTTP ${code}`), { status: code })
/** An error carrying the network code `code`, as Node's and undici's do */
const network = (code: string) => Object.assign(new Error("socket hang up"), { code })

describe("withRetry", () => {
	it("returns the first result when nothing throws", async () => {
		const fn = vi.fn(async () => "ok")
		expect(await withRetry(fn, fast)).toBe("ok")
		expect(fn).toHaveBeenCalledTimes(1)
	})

	/* S7 of the 0.15.0 review: transience is read from codes and statuses, the error's or its causes' */
	const retryable: Array<[string, Error]> = [
		["an HTTP 429", httpStatus(429)],
		["an HTTP 503", httpStatus(503)],
		[
			"libsql's wrap of a 429",
			Object.assign(new Error("server error"), { cause: httpStatus(429), code: "SERVER_ERROR" }),
		],
		["undici's fetch failed over a reset", new TypeError("fetch failed", { cause: network("ECONNRESET") })],
		["a timed-out connection", network("ETIMEDOUT")],
		["a socket undici closed", network("UND_ERR_SOCKET")],
	]

	it.each(retryable)("retries %s and succeeds on the next attempt", async (_, error) => {
		let calls = 0
		const result = await withRetry(async () => {
			calls++
			if (calls === 1) throw error
			return "recovered"
		}, fast)
		expect(result).toBe("recovered")
		expect(calls).toBe(2)
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
	])("does not retry %s", async (_, error) => {
		let calls = 0
		await expect(
			withRetry(async () => {
				calls++
				throw error
			}, fast),
		).rejects.toBe(error)
		expect(calls).toBe(1)
	})
})

describe("withRetry: retry limits", () => {
	it("gives up after maxRetries and rethrows the last error", async () => {
		let calls = 0
		await expect(
			withRetry(
				async () => {
					calls++
					throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })
				},
				{ ...fast, maxRetries: 2 },
			),
		).rejects.toThrow("ECONNRESET")
		/* the initial attempt plus two retries */
		expect(calls).toBe(3)
	})

	it("reports each retry with an increasing attempt number", async () => {
		const seen: number[] = []
		await expect(
			withRetry(
				async () => {
					throw Object.assign(new Error("429"), { status: 429 })
				},
				{ ...fast, maxRetries: 2, onRetry: (attempt) => seen.push(attempt) },
			),
		).rejects.toThrow()
		expect(seen).toEqual([1, 2])
	})
})

describe("withRetry: backoff delays", () => {
	it("caps the backoff delay at maxDelay", async () => {
		const delays: number[] = []
		await expect(
			withRetry(
				async () => {
					throw Object.assign(new Error("429"), { status: 429 })
				},
				{ baseDelay: 1000, maxDelay: 5, maxRetries: 3, onRetry: (_a, _e, delay) => delays.push(delay) },
			),
		).rejects.toThrow()
		expect(delays.every((d) => d <= 5)).toBe(true)
	})

	it("backs off from one second, doubling, capped at thirty seconds by default", async () => {
		vi.useFakeTimers()
		vi.spyOn(Math, "random").mockReturnValue(0)
		try {
			const delays: number[] = []
			const fn = vi.fn(async () => {
				throw Object.assign(new Error("429 too many"), { status: 429 })
			})
			const done = withRetry(fn, { maxRetries: 6, onRetry: (_a, _e, delay) => delays.push(delay) }).catch(
				(e: Error) => e,
			)
			await vi.runAllTimersAsync()
			expect(await done).toBeInstanceOf(Error)
			expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000])
		} finally {
			vi.restoreAllMocks()
			vi.useRealTimers()
		}
	})
})

describe("withRetry: edge cases", () => {
	it("still calls fn once when maxRetries is zero or less, and throws its own error", async () => {
		for (const maxRetries of [0, -1]) {
			const fn = vi.fn(async () => {
				throw new Error("fetch failed")
			})
			await expect(withRetry(fn, { ...fast, maxRetries })).rejects.toThrow("fetch failed")
			expect(fn).toHaveBeenCalledTimes(1)
		}
	})

	it("wraps a non-Error throw so the caller always sees an Error", async () => {
		await expect(
			withRetry(async () => {
				throw "just a string"
			}, fast),
		).rejects.toThrow("just a string")
	})
})

describe("circuit breaker", () => {
	it("starts closed with nothing recorded", () => {
		expect(createCircuitBreaker()).toEqual({ failures: 0, totalProcessed: 0, tripped: false })
	})

	it("counts outcomes without mutating the state it was given", () => {
		const initial = createCircuitBreaker()
		const next = updateCircuitBreaker(initial, false)

		expect(next).toMatchObject({ failures: 1, totalProcessed: 1 })
		expect(initial).toMatchObject({ failures: 0, totalProcessed: 0 })
		expect(updateCircuitBreaker(next, true)).toMatchObject({ failures: 1, totalProcessed: 2 })
	})

	it("stays closed below the minimum sample size, however bad the rate", () => {
		let state = createCircuitBreaker()
		for (let i = 0; i < 10; i++) state = updateCircuitBreaker(state, false)

		expect(checkCircuitBreaker(state).tripped).toBe(false)
	})

	it("trips once the failure rate crosses the threshold with enough samples", () => {
		let state = createCircuitBreaker()
		for (let i = 0; i < 50; i++) state = updateCircuitBreaker(state, i >= 10)

		const checked = checkCircuitBreaker(state)
		expect(checked.tripped).toBe(true)
		expect(checked.tripReason).toContain("20.0%")
		expect(checked.tripReason).toContain("50")
	})

	it("stays closed when the rate is under the threshold", () => {
		let state = createCircuitBreaker()
		for (let i = 0; i < 100; i++) state = updateCircuitBreaker(state, i >= 5)

		expect(checkCircuitBreaker(state).tripped).toBe(false)
	})

	it("honours custom threshold and sample size", () => {
		let state = createCircuitBreaker()
		for (let i = 0; i < 10; i++) state = updateCircuitBreaker(state, i >= 5)

		expect(checkCircuitBreaker(state, { failureThreshold: 0.5, minSampleSize: 10 }).tripped).toBe(true)
		expect(checkCircuitBreaker(state, { failureThreshold: 0.9, minSampleSize: 10 }).tripped).toBe(false)
	})

	it("stays tripped once tripped, without re-evaluating", () => {
		const tripped = { failures: 99, totalProcessed: 100, tripped: true, tripReason: "original" }
		expect(checkCircuitBreaker(tripped)).toBe(tripped)
	})
})

describe("aggregateErrors", () => {
	it("says so plainly when there are no errors", () => {
		expect(aggregateErrors([])).toBe("No errors")
	})

	const classified: Array<[string, string]> = [
		["SQLITE_CONSTRAINT: UNIQUE failed", "Constraint violation"],
		["no such table: post", "Missing table"],
		["no such column: title", "Missing column"],
		["table post already exists", "Already exists"],
		["ECONNRESET", "Network error"],
		["fetch failed", "Network error"],
		["429 slow down", "Rate limited"],
		["rate limit hit", "Rate limited"],
		["timeout after 30s", "Timeout"],
		["something else entirely", "Unknown"],
	]

	for (const [message, label] of classified) {
		it(`classifies "${message.slice(0, 24)}" as ${label}`, () => {
			expect(aggregateErrors([{ database: "core", error: message }])).toBe(`${label}: 1`)
		})
	}

	it("counts each class and orders the summary by frequency", () => {
		const summary = aggregateErrors([
			{ database: "a", error: "no such table: x" },
			{ database: "b", error: "ECONNRESET" },
			{ database: "c", error: "ECONNRESET" },
			{ database: "d", error: "ECONNRESET" },
		])
		expect(summary).toBe("Network error: 3, Missing table: 1")
	})
})

/** Prints the summary for `results` and returns its lines joined. */
function capture(results: MigrationResult[]): string {
	const lines: string[] = []
	printMigrationSummary(results, (line) => lines.push(line))
	return lines.join("\n")
}

/** Builds a minimal MigrationResult for the summary. */
const migrationResult = (status: MigrationResult["status"], database: string, error?: string) =>
	({ database, error, status }) as MigrationResult

describe("printMigrationSummary", () => {
	it("counts applied, skipped and failed separately", () => {
		const out = capture([
			migrationResult("success", "a"),
			migrationResult("repaired", "b"),
			migrationResult("already_applied", "c"),
			migrationResult("skipped", "d"),
			migrationResult("failed", "e", "boom"),
		])
		expect(out).toContain("2 applied")
		expect(out).toContain("2 skipped")
		expect(out).toContain("1 failed")
	})

	it("names every failure with its error", () => {
		const out = capture([migrationResult("failed", "core", "no such table")])
		expect(out).toContain("core: no such table")
	})

	it("omits a category with nothing in it", () => {
		const out = capture([migrationResult("success", "a")])
		expect(out).toContain("1 applied")
		expect(out).not.toContain("failed")
	})
})

describe("dropsQuestion", () => {
	it("names the drops and the target", () => {
		expect(dropsQuestion(["DROP TABLE post"], "core (prod)")).toContain("1. DROP TABLE post")
		expect(dropsQuestion(["DROP TABLE post"], "core (prod)")).toContain("This affects: core (prod)")
	})
})
