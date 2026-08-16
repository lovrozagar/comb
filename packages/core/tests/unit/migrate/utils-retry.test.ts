import { describe, expect, it, vi } from "vitest"
import {
	aggregateErrors,
	checkCircuitBreaker,
	createCircuitBreaker,
	printMigrationSummary,
	sleep,
	updateCircuitBreaker,
	withRetry,
} from "../../../src/migrate/core/utils.ts"
import type { MigrationResult } from "../../../src/migrate/types.ts"

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

describe("withRetry", () => {
	it("returns the first result when nothing throws", async () => {
		const fn = vi.fn(async () => "ok")
		expect(await withRetry(fn, fast)).toBe("ok")
		expect(fn).toHaveBeenCalledTimes(1)
	})

	const retryable = ["429 Too Many Requests", "rate limit exceeded", "ECONNRESET", "ETIMEDOUT", "fetch failed"]

	for (const message of retryable) {
		it(`retries a ${message.split(" ")[0]} failure and succeeds on the next attempt`, async () => {
			let calls = 0
			const result = await withRetry(async () => {
				calls++
				if (calls === 1) throw new Error(message)
				return "recovered"
			}, fast)

			expect(result).toBe("recovered")
			expect(calls).toBe(2)
		})
	}

	it("does not retry an error it cannot attribute to transient failure", async () => {
		let calls = 0
		await expect(
			withRetry(async () => {
				calls++
				throw new Error("syntax error near SELECT")
			}, fast),
		).rejects.toThrow("syntax error")
		expect(calls).toBe(1)
	})

	it("gives up after maxRetries and rethrows the last error", async () => {
		let calls = 0
		await expect(
			withRetry(
				async () => {
					calls++
					throw new Error("ECONNRESET")
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
					throw new Error("429")
				},
				{ ...fast, maxRetries: 2, onRetry: (attempt) => seen.push(attempt) },
			),
		).rejects.toThrow()
		expect(seen).toEqual([1, 2])
	})

	it("caps the backoff delay at maxDelay", async () => {
		const delays: number[] = []
		await expect(
			withRetry(
				async () => {
					throw new Error("429")
				},
				{ baseDelay: 1000, maxDelay: 5, maxRetries: 3, onRetry: (_a, _e, delay) => delays.push(delay) },
			),
		).rejects.toThrow()
		expect(delays.every((d) => d <= 5)).toBe(true)
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

describe("printMigrationSummary", () => {
	function capture(results: MigrationResult[]): string {
		const lines: string[] = []
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
			lines.push(args.join(" "))
		})
		printMigrationSummary(results)
		spy.mockRestore()
		return lines.join("\n")
	}

	const result = (status: MigrationResult["status"], database: string, error?: string) =>
		({ database, error, status }) as MigrationResult

	it("counts applied, skipped and failed separately", () => {
		const out = capture([
			result("success", "a"),
			result("repaired", "b"),
			result("already_applied", "c"),
			result("skipped", "d"),
			result("failed", "e", "boom"),
		])
		expect(out).toContain("2 applied")
		expect(out).toContain("2 skipped")
		expect(out).toContain("1 failed")
	})

	it("names every failure with its error", () => {
		const out = capture([result("failed", "core", "no such table")])
		expect(out).toContain("core: no such table")
	})

	it("omits a category with nothing in it", () => {
		const out = capture([result("success", "a")])
		expect(out).toContain("1 applied")
		expect(out).not.toContain("failed")
	})
})
