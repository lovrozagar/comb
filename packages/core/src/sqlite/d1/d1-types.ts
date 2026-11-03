/**
 * The D1 surface comb calls, as structural types of its own (K3 of r21), as the router's KV is: a
 * Worker typed by `wrangler types`, whose globals declare D1, and one typed by
 * `@cloudflare/workers-types` both fit them, so comb's D1 modules are typed in either and need
 * neither installed. Where comb hands a client on, it hands the caller's own type back.
 */

/** A prepared statement as comb uses one: bound, then batched */
type D1StatementLike = { bind(...values: unknown[]): D1StatementLike }

/** One statement's answer in a batch: the rows comb reads */
type D1AnswerLike<T> = { results: T[] }

/** A D1 session: what comb prepares and batches on, and the bookmark it hands on */
type D1SessionLike = {
	batch<T = unknown>(statements: D1StatementLike[]): Promise<Array<D1AnswerLike<T>>>
	getBookmark(): string | null
	prepare(query: string): D1StatementLike
}

/** A D1 database binding; one with no `withSession` is a runtime without sessions (an older Miniflare) */
type D1DatabaseLike = {
	batch<T = unknown>(statements: D1StatementLike[]): Promise<Array<D1AnswerLike<T>>>
	prepare(query: string): D1StatementLike
	withSession?(constraintOrBookmark?: string): D1SessionLike
}

/** The session type `D`'s `withSession` opens: the caller's own, so drizzle() takes it as it takes `D`; a D1 session where `D` names none */
type SessionOf<D extends D1DatabaseLike> = D extends { withSession(...args: never[]): infer S } ? S : D1SessionLike

export type { D1AnswerLike, D1DatabaseLike, D1SessionLike, D1StatementLike, SessionOf }
