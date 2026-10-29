/**
 * The one sink library code that absorbs a failure writes to when its caller gave no log of its own
 * (lint/no-console.js names it): the shard router's KV and revalidation errors among them (K15 of r17).
 */

/** A log that sends each `*.error` event to console.warn, with its data, and drops every other */
function warnOnError(event: string, data: Record<string, unknown>): void {
	if (event.endsWith(".error")) console.warn(event, data)
}

export { warnOnError }
