/**
 * Utility functions for migrations
 */
import type { CircuitBreakerState, MigrationResult } from "../types.ts"
import { EMPTY_OBJ } from "../../types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   SLEEP
   ═══════════════════════════════════════════════════════════════════════════ */

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ═══════════════════════════════════════════════════════════════════════════
   RETRY WITH BACKOFF
   ═══════════════════════════════════════════════════════════════════════════ */

export type RetryOptions = {
	maxRetries?: number
	baseDelay?: number
	maxDelay?: number
	onRetry?: (attempt: number, error: Error, delay: number) => void
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = EMPTY_OBJ): Promise<T> {
	const maxRetries = options.maxRetries ?? 3
	const baseDelay = options.baseDelay ?? 1000
	const maxDelay = options.maxDelay ?? 30000

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn()
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			const isRetryable =
				error.message.includes("429") ||
				error.message.includes("rate limit") ||
				error.message.includes("ECONNRESET") ||
				error.message.includes("ETIMEDOUT") ||
				error.message.includes("fetch failed")

			if (!isRetryable || attempt >= maxRetries) {
				throw error
			}

			/* Exponential backoff with jitter */
			const exponentialDelay = baseDelay * Math.pow(2, attempt)
			const jitter = Math.random() * 1000
			const delay = Math.min(exponentialDelay + jitter, maxDelay)

			if (options.onRetry) {
				options.onRetry(attempt + 1, error, delay)
			}

			await sleep(delay)
		}
	}

	throw new Error("Max retries exceeded")
}

/* ═══════════════════════════════════════════════════════════════════════════
   CIRCUIT BREAKER
   ═══════════════════════════════════════════════════════════════════════════ */

export function createCircuitBreaker(): CircuitBreakerState {
	return { failures: 0, totalProcessed: 0, tripped: false }
}

export function updateCircuitBreaker(state: CircuitBreakerState, success: boolean): CircuitBreakerState {
	return {
		...state,
		failures: state.failures + (success ? 0 : 1),
		totalProcessed: state.totalProcessed + 1,
	}
}

export function checkCircuitBreaker(
	state: CircuitBreakerState,
	options: { failureThreshold?: number; minSampleSize?: number } = EMPTY_OBJ,
): CircuitBreakerState {
	const failureThreshold = options.failureThreshold ?? 0.1
	const minSampleSize = options.minSampleSize ?? 50

	if (state.tripped) return state
	if (state.totalProcessed < minSampleSize) return state

	const failureRate = state.failures / state.totalProcessed

	if (failureRate >= failureThreshold) {
		return {
			...state,
			tripReason: `Failure rate ${(failureRate * 100).toFixed(1)}% exceeds threshold ${failureThreshold * 100}% after ${state.totalProcessed} stores`,
			tripped: true,
		}
	}

	return state
}

/* ═══════════════════════════════════════════════════════════════════════════
   ERROR AGGREGATION
   ═══════════════════════════════════════════════════════════════════════════ */

export function aggregateErrors(errors: Array<{ database: string; error: string }>): string {
	const byType = new Map<string, number>()

	for (const { error } of errors) {
		let type = "Unknown"
		if (error.includes("SQLITE_CONSTRAINT")) type = "Constraint violation"
		else if (error.includes("no such table")) type = "Missing table"
		else if (error.includes("no such column")) type = "Missing column"
		else if (error.includes("already exists")) type = "Already exists"
		else if (error.includes("ECONNRESET") || error.includes("fetch failed")) type = "Network error"
		else if (error.includes("429") || error.includes("rate limit")) type = "Rate limited"
		else if (error.includes("timeout")) type = "Timeout"

		byType.set(type, (byType.get(type) ?? 0) + 1)
	}

	const summary = Array.from(byType.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([type, count]) => `${type}: ${count}`)
		.join(", ")

	return summary || "No errors"
}

/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATION SUMMARY
   ═══════════════════════════════════════════════════════════════════════════ */

export function printMigrationSummary(results: MigrationResult[]): void {
	const success = results.filter((r) => r.status === "success" || r.status === "repaired")
	const skipped = results.filter((r) => r.status === "already_applied" || r.status === "skipped")
	const failed = results.filter((r) => r.status === "failed")

	const parts: string[] = []
	if (success.length > 0) parts.push(`${success.length} applied`)
	if (skipped.length > 0) parts.push(`${skipped.length} skipped`)
	if (failed.length > 0) parts.push(`${failed.length} failed`)

	console.log(`\n${parts.join(", ")}`)

	for (const r of failed) {
		console.log(`  ✗ ${r.database}: ${r.error}`)
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIRMATION PROMPT
   ═══════════════════════════════════════════════════════════════════════════ */

export async function confirmDrops(drops: string[], target: string, autoConfirm: boolean): Promise<boolean> {
	if (drops.length === 0) return true

	console.log("\n⚠️  DESTRUCTIVE CHANGES DETECTED\n")
	console.log("The following will be dropped:")
	drops.forEach((drop, i) => {
		console.log(`  ${i + 1}. ${drop}`)
	})
	console.log(`\nThis affects: ${target}`)

	if (autoConfirm) {
		console.log("\n✅ Auto-confirmed (--yes flag)\n")
		return true
	}

	process.stdout.write("\nApply? (y/N): ")
	const answer = await new Promise<string>((resolve) => {
		process.stdin.once("data", (data) => resolve(data.toString().trim().toLowerCase()))
	})

	if (answer !== "y" && answer !== "yes") {
		console.log("\n❌ Aborted\n")
		return false
	}

	console.log()
	return true
}
