import type { StatusKey } from "./types.ts"
import { statusKeyToCode } from "./types.ts"

/** A public field as a class field defines it, whatever the compiler's class-field setting */
const shown = (value: unknown): PropertyDescriptor => ({ configurable: true, enumerable: true, value, writable: true })

/**
 * A database or query failure in your domain's terms: an error key, an HTTP status, and the table and
 * column it concerns. Its message is `errorKey`; `toJSON()` gives the body a client may see, and the
 * original error stays on `source`, never serialized.
 */
export class CombError extends Error {
	/*
	 * Each field is defined in the constructor, never assigned: Bun compiles comb's
	 * source under the consumer's tsconfig, and with `useDefineForClassFields: false` an assigned
	 * `column` landed in JavaScriptCore's own non-enumerable Error.column, out of the JSON body.
	 */
	/** A message safe to show the client. The original error is on `source`. */
	declare readonly cause?: string | undefined
	/** The SQL name of the column the error concerns; unset when it is private or unknown */
	declare readonly column?: string | undefined
	/** What went wrong, as a stable key, one of `combErrorKeys` or a constraint map's own */
	declare readonly errorKey: string
	/** The HTTP status code for `statusKey`, such as 409 for `conflict` */
	declare readonly status: number
	/** The status the error answers with, by name */
	declare readonly statusKey: StatusKey
	/** The SQL name of the table the error concerns, when known */
	declare readonly table?: string | undefined
	/** The error this one was made from, for logs. Never serialized: it can hold SQL and bound values. */
	declare readonly source: unknown

	/** An error with `opts.errorKey` as its message; `status` is a status key, and the code is derived from it */
	constructor(opts: {
		/** A message safe to show the client. The original error goes on `source`. */
		cause?: string | undefined
		/** The SQL name of the column the error concerns */
		column?: string | undefined
		/** What went wrong, as a stable key */
		errorKey: string
		/** The original error, kept for logs and never serialized. */
		source?: unknown
		/** The status the error answers with, by name: `conflict`, not 409 */
		status: StatusKey
		/** The SQL name of the table the error concerns */
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
		/** The column, left out when unset */
		column?: string | undefined
		/** What went wrong, as the stable key a client branches on */
		errorKey: string
		/** The HTTP status code */
		status: number
		/** The status, by name */
		statusKey: StatusKey
		/** The table, left out when unset */
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
