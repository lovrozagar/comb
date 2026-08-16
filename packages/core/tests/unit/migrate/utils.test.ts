import { describe, expect, it } from "vitest"
import {
	aggregateErrors,
	checkCircuitBreaker,
	createCircuitBreaker,
	updateCircuitBreaker,
} from "../../../src/migrate/core/utils.ts"

describe("circuit breaker", () => {
	it("starts in healthy state", () => {
		const state = createCircuitBreaker()
		expect(state.tripped).toBe(false)
		expect(state.failures).toBe(0)
		expect(state.totalProcessed).toBe(0)
	})

	it("tracks successes and failures", () => {
		let state = createCircuitBreaker()
		state = updateCircuitBreaker(state, true)
		expect(state.totalProcessed).toBe(1)
		expect(state.failures).toBe(0)

		state = updateCircuitBreaker(state, false)
		expect(state.totalProcessed).toBe(2)
		expect(state.failures).toBe(1)
	})

	it("does not trip below min sample size", () => {
		let state = createCircuitBreaker()
		for (let i = 0; i < 10; i++) {
			state = updateCircuitBreaker(state, false)
		}
		state = checkCircuitBreaker(state, { minSampleSize: 50 })
		expect(state.tripped).toBe(false)
	})

	it("trips when failure rate exceeds threshold", () => {
		let state = createCircuitBreaker()
		/* 10 failures out of 50 = 20% > 10% threshold */
		for (let i = 0; i < 40; i++) {
			state = updateCircuitBreaker(state, true)
		}
		for (let i = 0; i < 10; i++) {
			state = updateCircuitBreaker(state, false)
		}
		state = checkCircuitBreaker(state, { failureThreshold: 0.1, minSampleSize: 50 })
		expect(state.tripped).toBe(true)
		expect(state.tripReason).toContain("20.0%")
	})

	it("stays tripped once tripped", () => {
		let state = createCircuitBreaker()
		state = { ...state, tripReason: "test", tripped: true }
		state = checkCircuitBreaker(state)
		expect(state.tripped).toBe(true)
	})
})

describe("aggregateErrors", () => {
	it("groups errors by type", () => {
		const result = aggregateErrors([
			{ database: "db1", error: "SQLITE_CONSTRAINT: UNIQUE" },
			{ database: "db2", error: "SQLITE_CONSTRAINT: FK" },
			{ database: "db3", error: "no such table: users" },
		])
		expect(result).toContain("Constraint violation: 2")
		expect(result).toContain("Missing table: 1")
	})

	it("returns 'No errors' for empty array", () => {
		expect(aggregateErrors([])).toBe("No errors")
	})

	it("handles network errors", () => {
		const result = aggregateErrors([
			{ database: "db1", error: "ECONNRESET" },
			{ database: "db2", error: "fetch failed" },
		])
		expect(result).toContain("Network error: 2")
	})
})
