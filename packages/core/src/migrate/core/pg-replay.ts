/**
 * The history replayed on devUrl's server, comb's objects and all, then read with the target's own
 * catalog query (P5 of r19): Postgres, not a model of it, decides what a cascade, a rename or a move
 * leaves, and the two sides compare as one read of two databases.
 *
 * The replay runs as Atlas applies (P1 ⊃ P2 of r20): each file in a transaction of its own, a
 * `-- atlas:txmode none` file statement by statement, committed, in a database made for it and
 * dropped after (pg-replay-database.ts). One transaction for the whole history filled Postgres's
 * lock table and left a seed's deferred trigger events pending, and devUrl's own database lent the
 * history what it held. Committed, a statement whose scope is the server or another database would
 * outlive the replay on devUrl's server, the target's own when they share one, so the replay runs
 * none (pg-outside-transaction.ts) and says which it left out; a CREATE ROLE runs bare, as a policy
 * needs its role, and comb drops each role it made (pg-replay-roles.ts).
 *
 * A DO block, a function, EXECUTE and CALL hide such a change from the parse tree, so Postgres
 * decides (P1 of r21): each transaction's writes to the shared catalogs are counted before its COMMIT
 * (pg-server-writes.ts), and one that wrote past its database, comb's own CREATE ROLE aside, is
 * refused and rolled back, naming the file and the change. A `txmode none` file runs each statement
 * a transaction allows in one of its own, so it is counted too; only the statements Postgres runs
 * outside one run bare, and none of those writes a shared catalog
 * (tests/integration/postgres/bare-statements.test.ts). The counts are this backend's own, so
 * another session's work never trips them, and with `track_counts` off they read zero, so the
 * replay refuses a server that keeps none.
 *
 * A SIGINT or a SIGTERM, a Ctrl-C or a cancelled CI job, skips a `finally`, so either runs the
 * replay's cleanup first, once, and then ends the process as the signal would (P2 of r21); a run
 * killed past it is swept by the next replay or apply on the server.
 */
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import { type PgTarget, refuseUrlProblems } from "./atlas-target.ts"
import { outsideTransaction } from "./classify-file.ts"
import { ReplayFailed } from "./replay-failed.ts"
import { asTarget } from "./pg-live-catalog.ts"
import { type Connect, failureOf, loadPostgres, readCatalog } from "./pg-live-objects.ts"
import type { LiveObjects } from "./pg-live-types.ts"
import { beyondDatabase, nodeOf, outsideOnly } from "./pg-outside-transaction.ts"
import {
	copyExtensions,
	dropRole,
	extensionsOf,
	makeDatabase,
	ownerOf,
	settle,
	type Sql,
	sweep,
} from "./pg-replay-database.ts"
import { grantsMade, ownGrant, ownRole, type Run } from "./pg-replay-roles.ts"
import { counting, namedChanges, refuseUncounted, sharedWrites, writesSince } from "./pg-server-writes.ts"
import { pgRead } from "./pg-split.ts"
import { postgresOptionsOf } from "./pg-url.ts"

/** A history file as baseline reads it */
type HistoryFile = { name: string; sql: string }

/* why comb loads postgres.js here */
const REPLAYS = "replay the history on devUrl, and read what it leaves, in a baseline"

/** How the replay words what it does, and where it says what it left out */
type Replay = {
	/** what the replay was doing, as a refusal names it */
	doing: string
	/** a statement left out, from `file`, and what it is */
	leftOut(file: string, sent: string, what: string): void
	/** a CREATE ROLE `sent` from `file` the replay ran without some of what it says */
	madeBare?: ((file: string, sent: string) => void) | undefined
	/** what a refusal stops */
	stops: string
}

/**
 * A transaction opened on the replay's connection, its counts so far taken as comb's own: a backend
 * keeps a committed transaction's counts in the next one's read until it flushes them, which it
 * never does inside a transaction (.tmp/grunt/r21-premise/p1-carry.log)
 */
async function begin(run: Run): Promise<void> {
	await run.sql.unsafe("BEGIN", [])
	run.ours = { rows: new Map(), writes: await sharedWrites(run.sql) }
}

/**
 * The open transaction committed, or refused, with nothing committed, when it wrote past its
 * database: in `name`, by `sent` when the transaction is that one statement's
 */
async function commit(run: Run, replay: Replay, { name, sent }: { name: string; sent?: string }): Promise<void> {
	/* a superuser's file can turn the counts off for its transaction or its session (P1a of r21) */
	if (!(await counting(run.sql)))
		throw new ReplayFailed(
			`${name}: the file turned track_counts off, so devUrl's server counted nothing it changed past the database the replay runs in, and comb rolled it back and refuses the file; leave track_counts on; ${replay.stops}`,
		)
	const counted = writesSince(await sharedWrites(run.sql), run.ours.writes)
	if (counted.size > 0) {
		const changes = await namedChanges({ sql: run.sql, was: run.admin }, counted, run.ours.rows)
		const by = sent === undefined ? "" : `, made by ${JSON.stringify(sent)}`
		throw new ReplayFailed(
			`${name}: devUrl's server counted a change past the database the replay runs in${by}: ${changes.join(", ")}. It came from inside a statement the replay cannot leave out (a DO block, a function, EXECUTE or CALL), and apply would make it on the target's server, so comb rolled it back and refuses the file; write the change as a statement of its own, which the replay leaves out and apply runs; ${replay.stops}`,
		)
	}
	await run.sql.unsafe("COMMIT", [])
}

/**
 * `file` run as Atlas applies it: in a transaction of its own unless `-- atlas:txmode none` gives it
 * up, and then each statement a transaction allows in one of its own
 */
async function replayFile(run: Run, { name, sql: text }: HistoryFile, replay: Replay & { refused: Refuse }) {
	const inFile = !outsideTransaction(text)
	if (inFile) await begin(run)
	for (const { sent, tree } of pgRead(text).statements) {
		const [type, node] = tree === undefined ? ["", {}] : nodeOf(tree)
		const beyond = grantsMade(run, type, node) ? undefined : beyondDatabase(type, node)
		if (beyond !== undefined) {
			replay.leftOut(name, sent, beyond)
			continue
		}
		const alone = !inFile && outsideOnly(type, node) === undefined
		if (alone) await begin(run)
		try {
			if (type === "CreateRoleStmt") {
				if (await ownRole(run, node)) replay.madeBare?.(name, sent)
			} else if (type === "GrantRoleStmt") await ownGrant(run, node, sent)
			else await run.sql.unsafe(sent, [])
		} catch (error) {
			throw replay.refused(`${name}: devUrl refused ${JSON.stringify(sent)} as ${replay.doing}`, error)
		}
		if (alone) await commit(run, replay, { name, sent })
	}
	if (inFile) await commit(run, replay, { name })
}

/* why a replay stops on a devUrl role that cannot make the database it replays in */
const NO_CREATEDB =
	"devUrl's role cannot create a database (CREATEDB), and comb replays the history file by file, as Atlas applies it, in a database of its own on devUrl's server; grant the role CREATEDB, or point devUrl at a server where it has it"

/** The replay's database made ready: counted, holding devUrl's extensions the `files` do not make, `schema` made and searched */
async function prepare(
	run: Run,
	schema: string,
	{ files, refused, stops }: { files: readonly HistoryFile[]; refused: Refuse; stops: string },
) {
	await refuseUncounted(run.sql, stops)
	await copyExtensions(run.admin, run.sql, {
		makes: extensionsOf(files.map(({ sql: text }) => text)),
		refused: (name, error) =>
			refused(
				`devUrl's database holds the extension ${name}, which comb could not make in the database it replays the history in`,
				error,
			),
	})
	if (schema !== "public") await run.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${sqlIdentifier(schema)}`, [])
	await run.sql.unsafe(`SET search_path TO ${sqlIdentifier(schema)}`, [])
}

/**
 * `run`'s cleanup, each step settled: its connection closed, a query in flight with it, any backend
 * still in its database ended, the database dropped, and each role it made
 */
async function cleanUp(run: Run): Promise<void> {
	await settle(() => run.sql.end({ timeout: 0 }))
	await settle(() =>
		run.admin.unsafe(
			"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
			[run.database],
		),
	)
	await settle(() => run.admin.unsafe(`DROP DATABASE IF EXISTS ${run.database}`, []))
	for (const role of run.created) await settle(() => dropRole(run.admin, role))
}

/* the cleanup of a replay that has made nothing yet */
const NOTHING = async (): Promise<void> => undefined

/**
 * A cleanup whose step runs at most once, set once there is something to clean: a signal before
 * that cleans nothing, and the step set after it still runs
 */
function onceCleanup(): { run: () => Promise<void>; set: (step: () => Promise<void>) => void } {
	let step = NOTHING
	let ran: Promise<void> | undefined
	return {
		run: () => (ran ??= step()),
		set: (next) => {
			step = next
			ran = undefined
		},
	}
}

/**
 * `body`, while SIGINT and SIGTERM run `cleanup` and then end the process as the signal would: by
 * the signal again, unless the host listens for it too and so ends it its own way
 */
async function onSignals<T>(cleanup: () => Promise<void>, body: () => Promise<T>): Promise<T> {
	const stop = (signal: NodeJS.Signals) => {
		void cleanup().finally(() => {
			if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
		})
	}
	process.once("SIGINT", stop).once("SIGTERM", stop)
	try {
		return await body()
	} finally {
		process.off("SIGINT", stop).off("SIGTERM", stop)
	}
}

/** A refusal: what failed, with devUrl's error, and what that stops */
type Refuse = (what: string, error: unknown) => ReplayFailed

/**
 * `files` replayed on `target`'s dev server in a database of their own, the schema made and searched
 * first; then `after` on its connection. A statement dev refuses is named, with dev's error, as what
 * was `doing`, and then what that `stops`
 */
async function onDev<T>(
	target: PgTarget,
	files: readonly HistoryFile[],
	{
		after,
		load,
		...replay
	}: Omit<Replay, "leftOut"> & {
		after: (sql: Sql) => Promise<T>
		leftOut?: Replay["leftOut"] | undefined
		load: () => Promise<Connect>
	},
): Promise<T> {
	refuseUrlProblems(target, { dev: true })
	const connect = await load()
	const failed = { field: "devUrl", url: target.devUrl, urls: [target.devUrl, target.url] } as const
	const refused: Refuse = (what, error) =>
		new ReplayFailed(`${what}: ${failureOf(error, failed)}; ${replay.stops}`, { cause: error })
	const options = { ...postgresOptionsOf(target.devUrl, "devUrl"), max: 1, onnotice: () => undefined }
	let admin: Sql | undefined
	try {
		const cleanup = onceCleanup()
		return await onSignals(cleanup.run, async () => {
			admin = connect(options)
			await sweep(admin, Date.now())
			const owner = await ownerOf(admin)
			const database = await makeDatabase(admin, owner, () => new ReplayFailed(`${NO_CREATEDB}; ${replay.stops}`))
			const run: Run = {
				admin,
				created: [],
				database,
				ours: { rows: new Map(), writes: new Map() },
				owner,
				sql: connect({ ...options, database }),
			}
			cleanup.set(() => cleanUp(run))
			try {
				await prepare(run, target.schema, { files, refused, stops: replay.stops })
				for (const file of files)
					await replayFile(run, file, { ...replay, leftOut: replay.leftOut ?? (() => undefined), refused })
				return await after(run.sql)
			} finally {
				await cleanup.run()
			}
		})
	} catch (error) {
		if (error instanceof ReplayFailed) throw error
		throw new ReplayFailed(`comb could not replay the history on devUrl: ${failureOf(error, failed)}`, {
			cause: error,
		})
	} finally {
		await admin?.end()
	}
}

/**
 * The catalog the history `files` leave in `target`'s schema, replayed on its dev server as Atlas
 * applied them (onDev), read by the target's own query (readCatalog). The role the replay
 * ran as stands for the target's role wherever the read names it (`targetUser`), as CURRENT_USER
 * names the role each database was built as
 */
async function replayCatalog(
	target: PgTarget,
	{ files, targetUser }: { files: readonly HistoryFile[]; targetUser: string },
	load: () => Promise<Connect> = () => loadPostgres(REPLAYS),
): Promise<LiveObjects> {
	return onDev(target, files, {
		after: async (sql) => asTarget(await readCatalog(sql, target.schema), targetUser),
		doing: "baseline replayed the history there",
		load,
		stops: "baseline compares nothing",
	})
}

export { type HistoryFile, onDev, replayCatalog }
