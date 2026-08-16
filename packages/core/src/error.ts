import type { StatusKey } from "./types.ts"
import { statusKeyToCode } from "./types.ts"

export class CombError extends Error {
	readonly column?: string | undefined
	readonly errorKey: string
	readonly status: number
	readonly statusKey: StatusKey
	readonly table?: string | undefined

	constructor(opts: {
		cause?: unknown
		column?: string | undefined
		errorKey: string
		status: StatusKey
		table?: string | undefined
	}) {
		super(opts.errorKey, opts.cause !== undefined ? { cause: opts.cause } : undefined)
		this.errorKey = opts.errorKey
		this.statusKey = opts.status
		this.status = statusKeyToCode[opts.status]
		this.column = opts.column
		this.table = opts.table
	}
}
