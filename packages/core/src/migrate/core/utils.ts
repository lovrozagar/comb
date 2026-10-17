/**
 * Utility functions for migrations
 */
import type { CircuitBreakerState, MigrationResult } from "../types.ts"
import { EMPTY_OBJ } from "../../empty.ts"

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

const TRANSIENT = ["429", "rate limit", "ECONNRESET", "ETIMEDOUT", "fetch failed"]

const isTransient = (error: Error) => TRANSIENT.some((mark) => error.message.includes(mark))

/** Call `fn`, again after a backoff while it fails transiently, `maxRetries` times at most */
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
	if (!isTransient(error) || done >= (options.maxRetries ?? 3)) throw error
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

export type ConfirmDrops = {
	/** --yes: apply without asking */
	autoConfirm: boolean
	/** How to ask the person running the migration; absent when nobody can be asked */
	confirm?: ((question: string) => Promise<boolean>) | undefined
}

/**
 * Whether a migration that drops `drops` may run on `target`: yes when it drops nothing or
 * autoConfirm is set, otherwise the answer to `dropsQuestion`, and no when nobody can be asked.
 */
export async function confirmDrops(drops: readonly string[], target: string, options: ConfirmDrops): Promise<boolean> {
	if (drops.length === 0 || options.autoConfirm) return true
	return options.confirm ? options.confirm(dropsQuestion(drops, target)) : false
}
