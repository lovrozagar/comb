import type { StatusKey } from "./types.ts"
import { statusKeyToCode } from "./types.ts"

/** A public field as a class field defines it, whatever the compiler's class-field setting */
const shown = (value: unknown): PropertyDescriptor => ({ configurable: true, enumerable: true, value, writable: true })

export class CombError extends Error {
	/*
	 * Each field is defined in the constructor, never assigned (KT5 of r22b): Bun compiles comb's
	 * source under the consumer's tsconfig, and with `useDefineForClassFields: false` an assigned
	 * `column` landed in JavaScriptCore's own non-enumerable Error.column, out of the JSON body.
	 */
	declare readonly column?: string | undefined
	declare readonly errorKey: string
	declare readonly status: number
	declare readonly statusKey: StatusKey
	declare readonly table?: string | undefined
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
		Object.defineProperties(this, {
			column: shown(opts.column),
			errorKey: shown(opts.errorKey),
			source: { enumerable: false, value: opts.source },
			status: shown(statusKeyToCode[opts.status]),
			statusKey: shown(opts.status),
			table: shown(opts.table),
		})
	}

	/** The body a client gets: the documented fields alone, however the engine enumerates them */
	toJSON(): {
		column?: string | undefined
		errorKey: string
		status: number
		statusKey: StatusKey
		table?: string | undefined
	} {
		const { column, errorKey, status, statusKey, table } = this
		return {
			...(column !== undefined && { column }),
			errorKey,
			status,
			statusKey,
			...(table !== undefined && { table }),
		}
	}
}
