import type { StatusKey } from "./types.ts"
import { statusKeyToCode } from "./types.ts"

export class CombError extends Error {
	readonly column?: string | undefined
	readonly errorKey: string
	readonly status: number
	readonly statusKey: StatusKey
	readonly table?: string | undefined
	/** The error this one was made from, for logs. Never serialized: it can hold SQL and bound values. */
	declare readonly source: unknown

	constructor(opts: {
		/** A message safe to show the client. */
		cause?: unknown
		column?: string | undefined
		errorKey: string
		/** The original error, kept for logs and never serialized. */
		source?: unknown
		status: StatusKey
		table?: string | undefined
	}) {
		super(opts.errorKey, opts.cause !== undefined ? { cause: opts.cause } : undefined)
		this.errorKey = opts.errorKey
		this.statusKey = opts.status
		this.status = statusKeyToCode[opts.status]
		this.column = opts.column
		this.table = opts.table
		Object.defineProperty(this, "source", { enumerable: false, value: opts.source })
	}
}
