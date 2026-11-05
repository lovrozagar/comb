// the D1 surface typed structurally
/**
 * The D1 surface comb calls, as structural types of its own, as the router's KV is: a
 * Worker typed by `wrangler types`, whose globals declare D1, and one typed by
 * `@cloudflare/workers-types` both fit them, so comb's D1 modules are typed in either and need
 * neither installed. Where comb hands a client on, it hands the caller's own type back.
 */

/** A prepared statement as comb uses one: bound, then batched */
type D1StatementLike = {
	/** binds `values` to the statement's `?` placeholders in order, and returns the bound statement */
	bind(...values: unknown[]): D1StatementLike
}

/** One statement's answer in a batch: the rows comb reads */
type D1AnswerLike<T> = {
	/** the rows the statement returned, in order; empty for a write without RETURNING */
	results: T[]
}

/** A D1 session: what comb prepares and batches on, and the bookmark it hands on */
type D1SessionLike = {
	/** runs `statements` in order as one transaction, which a failing statement rolls back whole; one answer per statement, in order */
	batch<T = unknown>(statements: D1StatementLike[]): Promise<Array<D1AnswerLike<T>>>
	/** the bookmark of the session's latest query, which a session opened on it reads at least as far as; null before its first query */
	getBookmark(): string | null
	/** prepares `query`, its values written as `?` placeholders, to bind and batch */
	prepare(query: string): D1StatementLike
}

/** A D1 database binding; one with no `withSession` is a runtime without sessions (an older Miniflare) */
type D1DatabaseLike = {
	/** runs `statements` in order as one transaction, which a failing statement rolls back whole; one answer per statement, in order */
	batch<T = unknown>(statements: D1StatementLike[]): Promise<Array<D1AnswerLike<T>>>
	/** prepares `query`, its values written as `?` placeholders, to bind and batch */
	prepare(query: string): D1StatementLike
	/** opens a session on a bookmark, or on `"first-primary"` or `"first-unconstrained"`; absent on a runtime without sessions */
	withSession?: ((constraintOrBookmark?: string) => D1SessionLike) | undefined
}

/** The session type `D`'s `withSession` opens: the caller's own, so drizzle() takes it as it takes `D`; a D1 session where `D` names none */
type SessionOf<D extends D1DatabaseLike> = D extends { withSession(...args: never[]): infer S } ? S : D1SessionLike

export type { D1AnswerLike, D1DatabaseLike, D1SessionLike, D1StatementLike, SessionOf }
