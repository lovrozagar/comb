/**
 * The replay's transactions and the reads around them (pg-replay.ts): a file's or comb's own
 * statement's transaction, refused before its COMMIT when this backend's counts show it wrote past
 * its database (P1 of r21), and the server's shared catalogs read as committed around it and around
 * every bare statement, a change there the file's when it is to an object the file names (P1 and
 * P2 of r22); a `txmode none` file's statement in a transaction of its own first, bare only when
 * Postgres runs it outside a block alone.
 */
import type { Run } from "./pg-replay-roles.ts"
import { added, snapshot, snapshotChanges } from "./pg-server-snapshot.ts"
import { counts, namedChanges, writesSince } from "./pg-server-writes.ts"
import { ReplayFailed } from "./replay-failed.ts"

/**
 * A transaction opened on the replay's connection, its counts so far taken as comb's own: a backend
 * keeps a committed transaction's counts in the next one's read until it flushes them, which it
 * never does inside a transaction (.tmp/grunt/r21-premise/p1-carry.log)
 */
async function begin(run: Run): Promise<void> {
	/* pipelined on the one connection: the read runs in the transaction BEGIN opens, a round trip saved */
	const [, now] = await Promise.all([run.sql.unsafe("BEGIN", []), counts(run.sql)])
	run.ours = { rows: new Map(), writes: now.writes }
}

/**
 * Where a replayed transaction or bare statement is: its file's name and the names it spells, the
 * statement, if bare, and what a refusal stops
 */
type At = { name: string; names: ReadonlySet<string>; sent: string | undefined; stops: string }

/**
 * The server's shared catalogs read as committed against the last read: a change since to an object
 * the file `name` names (`names`), while `sent` or the whole file ran, is refused, and a role or
 * database it added is the cleanup's; a change to any other is another session's (P2 of r22)
 */
async function window(run: Run, { name, names, sent, stops }: At): Promise<void> {
	const now = await snapshot(run.admin)
	const changes = snapshotChanges(run.seen, now, names)
	const { databases, roles, slots } = added(run.seen, now, names)
	run.seen = now
	if (changes.length === 0) return
	run.strays.databases.push(...databases)
	run.strays.roles.push(...roles)
	run.strays.slots.push(...slots)
	const strays = [
		...roles.map((role) => `role ${role}`),
		...databases.map((database) => `database ${database} unless a session is in it`),
		...slots.map((slot) => `replication slot ${slot} unless a session holds it`),
	]
	const dropped = strays.length === 0 ? "" : `; comb drops ${strays.join(", ")}, which the file added`
	/* the read is committed, so a change it shows to an object the file did not add stays */
	const dropping = new Set([
		...roles.map((role) => `role ${role} added`),
		...databases.map((d) => `database ${d} added`),
		...slots.map((slot) => `replication slot ${slot} added`),
	])
	const kept = changes.filter((change) => !dropping.has(change))
	const left = kept.length === 0 ? "" : `; devUrl's server keeps ${kept.join(", ")}, which comb cannot undo`
	throw new ReplayFailed(
		`${name}: devUrl's server changed past the database the replay runs in while ${sent === undefined ? "the file" : JSON.stringify(sent)} ran: ${changes.join(", ")}. A change made there, from inside a DO block, a function, EXECUTE or CALL, or over a second connection such as dblink's, apply would make on the target's server, so comb refuses the file; write the change as a statement of its own, which the replay leaves out and apply runs${dropped}${left}; ${stops}`,
	)
}

/**
 * The open transaction committed, or refused, with nothing committed, when it wrote past its
 * database, by its own counts or the server's catalogs: in `name`, by `sent` when the transaction is
 * that one statement's
 */
async function commit(run: Run, at: At): Promise<void> {
	const { name, sent, stops } = at
	/* a superuser's file can turn the counts off for its transaction or its session (P1a of r21) */
	const now = await counts(run.sql)
	if (!now.on)
		throw new ReplayFailed(
			`${name}: the file turned track_counts off, so devUrl's server counted nothing it changed past the database the replay runs in, and comb rolled it back and refuses the file; leave track_counts on; ${stops}`,
		)
	const counted = writesSince(now.writes, run.ours.writes)
	if (counted.size > 0) {
		const changes = await namedChanges({ sql: run.sql, was: run.admin }, counted, run.ours.rows)
		const by = sent === undefined ? "" : `, made by ${JSON.stringify(sent)}`
		throw new ReplayFailed(
			`${name}: devUrl's server counted a change past the database the replay runs in${by}: ${changes.join(", ")}. It came from inside a statement the replay cannot leave out (a DO block, a function, EXECUTE or CALL), and apply would make it on the target's server, so comb rolled it back and refuses the file; write the change as a statement of its own, which the replay leaves out and apply runs; ${stops}`,
		)
	}
	await window(run, at)
	await run.sql.unsafe("COMMIT", [])
}

// lookup-table: the codes Postgres refuses a statement with in a transaction block that it runs bare: an outside-only class (25001), a COMMIT inside a DO block or a procedure (2D000)
const BARE_ONLY: ReadonlySet<unknown> = /* @__PURE__ */ new Set(["25001", "2D000"])

/**
 * A statement of a `txmode none` file `send` runs, first in a transaction of its own, refused before
 * its COMMIT as a file's is (the amendment to P1 of r22): a change it makes past its database never
 * commits. Postgres refuses only an outside-only class and a COMMIT inside a DO block or a procedure
 * in a block; that try rolled back whole, so it runs bare, as Atlas sends it, with the server's
 * catalogs read around it
 */
async function guarded(run: Run, at: At, send: () => Promise<void>): Promise<void> {
	await begin(run)
	const refused = await send().then(
		() => undefined,
		(error: unknown) => error,
	)
	if (refused === undefined) return commit(run, at)
	if (!BARE_ONLY.has((refused as { cause?: { code?: unknown } }).cause?.code)) throw refused
	await run.sql.unsafe("ROLLBACK", [])
	await send()
	return window(run, at)
}

export { type At, begin, commit, guarded, window }
