/**
 * The replay's transactions and the reads around them (pg-replay.ts): a file's or comb's own
 * statement's transaction, refused before its COMMIT when this backend's counts show it wrote past
 * its database (P1 of r21), and the server's shared catalogs read as committed around it and around
 * every bare statement, a change there the file's when it is to an object the file names (P1 and
 * P2 of r22); a `txmode none` file's statement in a transaction of its own first, bare only when
 * Postgres runs it outside a block alone.
 */
import { adopt, bareAgain, type Run } from "./pg-replay-roles.ts"
import { added, type Snapshot, snapshot, snapshotChanges } from "./pg-server-snapshot.ts"
import {
	type Change,
	catalogsOf,
	counts,
	type Own,
	refusedChanges,
	rowChanges,
	writesSince,
} from "./pg-server-writes.ts"
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
 * statement, if bare, and what a refusal stops; told each role the transaction adds that the replay
 * adopts
 */
type At = {
	adopted?: ((role: string) => void) | undefined
	name: string
	names: ReadonlySet<string>
	sent: string | undefined
	stops: string
}

/* the words that name devUrl's role in a file, as namesIn folds them: CURRENT_USER and its kin (AE6 of r22) */
const SESSION_ROLE = ["current_role", "current_user", "session_user", "user"]

/**
 * The server's shared catalogs read as committed against the last read: a change since to an object
 * the file `name` names (`names`), while `sent` or the whole file ran, is refused, and a role or
 * database it added is the cleanup's; a change to any other is another session's (P2 of r22). The
 * replay's own database is the file's whatever it spells, as only this replay runs in it, and is
 * the cleanup's too. `read` is that read when the caller took it
 */
async function window(run: Run, at: At, read?: Snapshot): Promise<void> {
	strayed(run, at, read ?? (await snapshot(run.admin)))
}

/**
 * window's verdict on `now`, the server's shared catalogs as committed after the file or `sent`,
 * against the last read; kept apart from window's await, as v8 miscounts a branch after an await
 */
function strayed(run: Run, { name, names, sent, stops }: At, now: Snapshot): void {
	const its = new Set([...names, run.database])
	if (SESSION_ROLE.some((word) => names.has(word))) its.add(run.role)
	const changes = snapshotChanges(run.seen, now, its)
	const { databases, roles, slots } = added(run.seen, now, its)
	run.seen = now
	if (changes.length === 0) return
	run.strays.databases.push(...databases)
	run.strays.roles.push(...roles)
	run.strays.slots.push(...slots)
	const own = `database ${run.database} `
	const strays = [
		...roles.map((role) => `role ${role}`),
		...databases.map((database) => `database ${database} unless a session is in it`),
		...slots.map((slot) => `replication slot ${slot} unless a session holds it`),
	]
	const replays = changes.some((change) => change.startsWith(own)) ? "; comb drops the database it replays in" : ""
	const dropped = `${strays.length === 0 ? "" : `; comb drops ${strays.join(", ")}, which the file added`}${replays}`
	/* the read is committed, so a change it shows to an object the file did not add stays */
	const dropping = new Set([
		...roles.map((role) => `role ${role} added`),
		...databases.map((d) => `database ${d} added`),
		...slots.map((slot) => `replication slot ${slot} added`),
	])
	const kept = changes.filter((change) => !dropping.has(change) && !change.startsWith(own))
	const left = kept.length === 0 ? "" : `; devUrl's server keeps ${kept.join(", ")}, which comb cannot undo`
	throw new ReplayFailed(
		`${name}: devUrl's server changed past the database the replay runs in while ${sent === undefined ? "the file" : JSON.stringify(sent)} ran: ${changes.join(", ")}. A change made there, from inside a DO block, a function, EXECUTE or CALL, or over a second connection such as dblink's, apply would make on the target's server, so comb refuses the file; write the change as a statement of its own, which the replay leaves out and apply runs${dropped}${left}; ${stops}`,
	)
}

// lookup-table: the fields of a database's row whose change keeps the cleanup from dropping it: a template, another owner
const UNDROPPABLE: ReadonlySet<string> = /* @__PURE__ */ new Set(["datdba", "datistemplate"])

// lookup-table: by a change's noun, where its row's names hold the roles whose drop takes the row with it
const ROLE_AT: ReadonlyArray<[noun: string, at: readonly number[]]> = [
	["comment on role ", [0]],
	["membership ", [0, 1]],
	["role ", [0]],
	["security label on role ", [0]],
	["setting ", [1]],
]

/**
 * Which changes are the replay's own, one rule: a change whose subject is what the replay drops
 * after it, so nothing outlives the check. The database it runs in (P3 of r22): its row, but a field
 * that keeps the cleanup from dropping it, its settings for every role, and its comment and security
 * labels. And each of `roles`, those it made or adopts (P5 of r22, PR6 of r22b): its row, a
 * membership in it or of it, its settings in any database, and its comment and security labels
 */
function ownOf(run: Run, roles: ReadonlySet<string>): Own {
	const database = `database ${run.database}`
	return ({ fields, names, subject }) =>
		(subject === database && fields.length > 0 && !fields.some((field) => UNDROPPABLE.has(field))) ||
		subject === `setting ${run.database} for every role` ||
		subject === `comment on ${database}` ||
		subject.startsWith(`security label on ${database} by `) ||
		(ROLE_AT.find(([noun]) => subject.startsWith(noun))?.[1] ?? []).some((at) => roles.has(names[at] ?? ""))
}

/** The roles the `changes` to pg_authid added: a row no role held before, which the replay may adopt */
const addedRoles = (changes: readonly Change[] = []): string[] =>
	changes.filter((change) => change.kind === "added").map((change) => String(change.names[0]))

/** The roles of `roles` whose own row `changes` to pg_authid added or changed, which the replay makes bare again */
const touchedRoles = (roles: ReadonlySet<string>, changes: readonly Change[] = []): string[] =>
	changes
		.filter((change) => change.kind !== "removed" && roles.has(String(change.names[0])))
		.map((change) => String(change.names[0]))

/**
 * The open transaction committed, or refused, with nothing committed, when it wrote past its
 * database, by its own counts or the server's catalogs: in `name`, by `sent` when the transaction is
 * that one statement's
 */
async function commit(run: Run, at: At): Promise<void> {
	const { name, sent, stops } = at
	/* two connections, one moment before COMMIT: the counts on the replay's, the committed catalogs on admin's, a round trip saved */
	const [now, read] = await Promise.all([counts(run.sql), snapshot(run.admin)])
	/* a superuser's file can turn the counts off for its transaction or its session (P1a of r21) */
	if (!now.on)
		throw new ReplayFailed(
			`${name}: the file turned track_counts off, so devUrl's server counted nothing it changed past the database the replay runs in, and comb rolled it back and refuses the file; leave track_counts on; ${stops}`,
		)
	const counted = writesSince(now.writes, run.ours.writes)
	const byCatalog =
		counted.size === 0
			? new Map<string, Change[]>()
			: await rowChanges({ catalogs: catalogsOf(run.superuser), sql: run.sql, was: run.admin }, counted, run.ours.rows)
	const adopting = addedRoles(byCatalog.get("pg_authid"))
	const roles = new Set([...run.created, ...adopting])
	const changes = refusedChanges(byCatalog, ownOf(run, roles))
	if (changes.length > 0) {
		const by = sent === undefined ? "" : `, made by ${JSON.stringify(sent)}`
		throw new ReplayFailed(
			`${name}: devUrl's server counted a change past the database the replay runs in${by}: ${changes.join(", ")}. It came from inside a statement the replay cannot leave out (a DO block, a function, EXECUTE or CALL), and apply would make it on the target's server, so comb rolled it back and refuses the file. A role such a statement adds, and a change to a role the replay made, are the replay's own, as it drops them after; for any other change, write it as a statement of its own: the replay leaves out one that reaches past its database, and apply runs it, while a CREATE ROLE runs in the replay, the role made bare; ${stops}`,
		)
	}
	await bareAgain(run, touchedRoles(roles, byCatalog.get("pg_authid")))
	await adopt(run, adopting)
	for (const role of adopting) at.adopted?.(role)
	await window(run, at, read)
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
	if (!BARE_ONLY.has((refused as { cause?: { code?: unknown } | undefined }).cause?.code)) throw refused
	await run.sql.unsafe("ROLLBACK", [])
	await send()
	return window(run, at)
}

export { type At, begin, commit, guarded, ownOf, window }
