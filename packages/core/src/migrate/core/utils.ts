/**
 * Utility functions for migrations
 */
import type { CircuitBreakerState, MigrationResult } from "../types.ts"
import { EMPTY_OBJ } from "../../empty.ts"
import { isTransient } from "./transient.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   SLEEP
   ═══════════════════════════════════════════════════════════════════════════ */

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ═══════════════════════════════════════════════════════════════════════════
   RETRY WITH BACKOFF
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * How `withRetry` retries. The wait before retry n (from 0) is `baseDelay * 2^n` plus up to 1000 ms
 * of jitter, capped at `maxDelay`
 */
export type RetryOptions = {
	/** retries after the first attempt, at most; default 3 */
	maxRetries?: number | undefined
	/** the first retry's wait before jitter, in milliseconds; default 1000 */
	baseDelay?: number | undefined
	/** the longest wait, in milliseconds; default 30000 */
	maxDelay?: number | undefined
	/** called before each wait with the retry's number from 1, the failure, and the wait in milliseconds */
	onRetry?: ((attempt: number, error: Error, delay: number) => void) | undefined
}

/**
 * Call `fn`, again after a backoff while it fails transiently, `maxRetries` times at most. A failure
 * is transient when it, or an error it was caused by, carries an HTTP status of 429 or 5xx or a
 * network code such as `ECONNRESET`; a SQLite error never is, and no message is read. Any other
 * failure, or the last one, is thrown, a non-Error wrapped in one
 */
export function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = EMPTY_OBJ): Promise<T> {
	return attempt(fn, options, 0)
}

/* Each attempt ends in the result, or in what its failure leads to */
async function attempt<T>(fn: () => Promise<T>, options: RetryOptions, done: number): Promise<T> {
	try {
		return await fn()
	} catch (err) {
		return retryAfter(err, { done, fn, options })
	}
}

type Retry<T> = { done: number; fn: () => Promise<T>; options: RetryOptions }

/** The next attempt after a transient failure, or the failure itself once retrying is over */
async function retryAfter<T>(err: unknown, { done, fn, options }: Retry<T>): Promise<T> {
	const error = err instanceof Error ? err : new Error(String(err))
	if (!isTransient(err) || done >= (options.maxRetries ?? 3)) throw error
	/* exponential backoff with jitter */
	const backoff = (options.baseDelay ?? 1000) * 2 ** done + Math.random() * 1000
	const delay = Math.min(backoff, options.maxDelay ?? 30000)
	options.onRetry?.(done + 1, error, delay)
	await sleep(delay)
	return attempt(fn, options, done + 1)
}

/* ═══════════════════════════════════════════════════════════════════════════
   CIRCUIT BREAKER
   ═══════════════════════════════════════════════════════════════════════════ */

/** A circuit breaker that has counted nothing and is not tripped */
export function createCircuitBreaker(): CircuitBreakerState {
	return { failures: 0, totalProcessed: 0, tripped: false }
}

/** `state` with one more database counted, and one more failure unless `success`; it never trips the breaker, `checkCircuitBreaker` does */
export function updateCircuitBreaker(state: CircuitBreakerState, success: boolean): CircuitBreakerState {
	return {
		...state,
		failures: state.failures + (success ? 0 : 1),
		totalProcessed: state.totalProcessed + 1,
	}
}

/**
 * `state`, tripped with its reason once at least `minSampleSize` databases are counted and the share
 * that failed reaches `failureThreshold`; a tripped state stays tripped
 */
export function checkCircuitBreaker(
	state: CircuitBreakerState,
	options: {
		/** the failed share, 0 to 1, that trips the breaker; default 0.1 */
		failureThreshold?: number | undefined
		/** the databases counted before the breaker may trip; default 50 */
		minSampleSize?: number | undefined
	} = EMPTY_OBJ,
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

/** Write the counts of applied, skipped and failed migrations to `out`, then each failure */
export function printMigrationSummary(results: MigrationResult[], out: (line: string) => void): void {
	const success = results.filter((r) => r.status === "success" || r.status === "repaired")
	const skipped = results.filter((r) => r.status === "already_applied" || r.status === "skipped")
	const failed = results.filter((r) => r.status === "failed")

	const parts: string[] = []
	if (success.length > 0) parts.push(`${success.length} applied`)
	if (skipped.length > 0) parts.push(`${skipped.length} skipped`)
	if (failed.length > 0) parts.push(`${failed.length} failed`)

	out(`\n${parts.join(", ")}`)
	for (const r of failed) out(`  ✗ ${r.database}: ${r.error}`)
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIRMATION
   ═══════════════════════════════════════════════════════════════════════════ */

/** The question a destructive migration asks before it runs: what it destroys, and where */
export function dropsQuestion(drops: readonly string[], target: string): string {
	return [
		"Destructive changes detected:",
		...drops.map((drop, i) => `  ${i + 1}. ${drop}`),
		`This affects: ${target}`,
		"Apply?",
	].join("\n")
}
