/**
 * The history replayed on devUrl's server, comb's objects and all, then read with the target's own
 * catalog query (P5 of r19): Postgres, not a model of it, decides what a cascade, a rename or a
 * move leaves, and the two sides compare as one read of two databases.
 *
 * The replay runs as Atlas applies (P1 ⊃ P2 of r20): each file on a session of its own, as apply
 * gives each file an Atlas call (PA1 of r22b), and in a transaction of its own, a `--
 * atlas:txmode none` file statement by statement, each in a transaction of its own first and bare,
 * as Atlas sends it, where Postgres runs it only so (P1 of r22 and its amendment), in a database
 * made for it and dropped after (pg-replay-database.ts). One transaction for the whole history
 * filled Postgres's lock table and left a seed's deferred trigger events pending, and devUrl's own
 * database lent the history what it held. Committed, a statement whose scope is the server or
 * another database would outlive the replay on devUrl's server, the target's own when they share
 * one, so the replay runs none (pg-outside-transaction.ts) and says which it left out; a CREATE
 * ROLE runs bare, as a policy needs its role, and comb drops each role it made
 * (pg-replay-roles.ts).
 *
 * A DO block, a function, EXECUTE and CALL hide such a change from the parse tree, so Postgres
 * decides, twice (pg-server-writes.ts). A file in a transaction has its writes to the shared
 * catalogs counted before its COMMIT (P1 of r21), and one that wrote past its database is refused
 * and rolled back, naming the file and the change, but for what the replay drops after it
 * (pg-replay-commit.ts): comb's own CREATE ROLE, a role such a statement adds, which the replay
 * adopts, a change to a role it made, and its own database. The counts are this backend's own, so
 * another session's work never trips them, and with `track_counts` off they read zero, so the
 * replay refuses a server that keeps none. And around every file and every statement a `txmode
 * none` file sends bare, the server's shared catalogs are read as committed, a replay's own rows
 * left out (P1 and P2 of r22): that sees a bare statement's change, which no transaction counts,
 * and one a second connection commits, as dblink's does, which this backend's counts never see.
 * Bare runs only a statement a block refuses (an outside-only class, a DO block or CALL that
 * commits), one only a block runs (a LOCK, a SAVEPOINT, a cursor not held) and the file's own
 * block, and a change one makes past its database has committed when the read sees it: the refusal
 * names what devUrl's server keeps. The read is the server's, another session's work in it too, so
 * a change there is the file's only when the role, database or other object it is to is one the
 * file names: a name it spells, unquoted and folded as Postgres folds it, quoted and exact, or
 * inside a string a DO body, dblink_exec or format() may run (namesIn in sql-code.ts). That change
 * is refused, naming it, and a role it added is dropped with the cleanup, as is a database it added
 * that no session is in; a change to any other object is another session's and passes. A name the
 * file builds at run time, by concatenation, from a query, or in a function another file defines,
 * is none it spells, so comb neither refuses nor drops that change. A role's password reads from
 * pg_authid alone, so a password a bare statement changes is seen by a superuser's devUrl only.
 *
 * A SIGINT or a SIGTERM, a Ctrl-C or a cancelled CI job, skips a `finally`, so either runs the
 * replay's cleanup first, once, and then ends the process as the signal would (P2 of r21); a run
 * killed past it is swept by the next replay or apply on the server.
 */
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import { type PgTarget, refuseUrlProblems } from "./atlas-target.ts"
import { onceCleanup, onSignals } from "./cleanup.ts"
import { ReplayFailed } from "./replay-failed.ts"
import { asTarget } from "./pg-live-catalog.ts"
import { outsideTransaction } from "./atlas-header.ts"
import { type Connect, failureOf, loadPostgres, readCatalog } from "./pg-live-objects.ts"
import type { LiveObjects } from "./pg-live-types.ts"
import { beyondDatabase, blockAfter, insideOnly, nodeOf } from "./pg-outside-transaction.ts"
import { claim, copyExtensions, extensionsOf, makeDatabase, replayOptions, type Sql } from "./pg-replay-database.ts"
import { cleanUp, leaving, sweep } from "./pg-replay-drops.ts"
import { devRoleOf, grantsMade, ownGrant, ownRole, type Run } from "./pg-replay-roles.ts"
import { begin, commit, guarded, window } from "./pg-replay-commit.ts"
import { prepareSnapshot, snapshot } from "./pg-server-snapshot.ts"
import { refuseUncounted } from "./pg-server-writes.ts"
import { pgRead } from "./pg-split.ts"
import { namesIn } from "./sql-code.ts"

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
	/** a role `file` added inside a statement the replay cannot leave out, adopted as one it made */
	adopted?: ((file: string, role: string) => void) | undefined
	/** what a refusal stops */
	stops: string
}

/** A replay's run of each file: the refusal it words, and the extensions waiting on one a file makes (PR1 of r22b) */
type Replaying = Replay & { refused: Refuse; waits: (sql: Sql) => Promise<void> }

/** `sent` run on the replay's connection, comb's own CREATE ROLE and GRANT of a role it made as comb runs them */
async function runStatement(
	run: Run,
	{ name, node, sent, type }: { name: string; node: Record<string, unknown>; sent: string; type: string },
	replay: Replaying,
): Promise<void> {
	try {
		if (type === "CreateRoleStmt") {
			if (await ownRole(run, node)) replay.madeBare?.(name, sent)
		} else if (type === "GrantRoleStmt") await ownGrant(run, node, sent)
		else await run.sql.unsafe(sent, [])
	} catch (error) {
		throw replay.refused(`${name}: devUrl refused ${JSON.stringify(sent)} as ${replay.doing}`, error)
	}
	/* an extension devUrl's database holds that requires the one just made follows it, as on the target */
	if (type === "CreateExtensionStmt") await replay.waits(run.sql)
}

/**
 * `file` run as Atlas applies it: in a transaction of its own unless `-- atlas:txmode none` gives it
 * up, and then each statement in a transaction of its own first (guarded), bare where Postgres runs
 * it only so; the file's own BEGIN, COMMIT and SAVEPOINT, a LOCK and a cursor not held, and all its
 * own block runs, bare, as Atlas sends them, so Postgres refuses outside a block what apply's refuses
 */
async function replayFile(run: Run, { name, sql: text }: HistoryFile, replay: Replaying) {
	const inFile = !outsideTransaction(text)
	const file = {
		adopted: (role: string) => replay.adopted?.(name, role),
		name,
		names: namesIn(text),
		stops: replay.stops,
	}
	let block = false
	if (inFile) await begin(run)
	for (const { sent, tree } of pgRead(text).statements) {
		const [type, node] = tree === undefined ? ["", {}] : nodeOf(tree)
		const beyond = grantsMade(run, type, node) ? undefined : beyondDatabase(type, node)
		if (beyond !== undefined) {
			replay.leftOut(name, sent, beyond)
			continue
		}
		const send = () => runStatement(run, { name, node, sent, type }, replay)
		if (inFile) await send()
		else if (block || type === "TransactionStmt" || insideOnly(type, node) !== undefined) {
			await send()
			block = blockAfter(block, type, node)
			await window(run, { ...file, sent })
		} else await guarded(run, { ...file, sent }, send)
	}
	if (inFile) await commit(run, { ...file, sent: undefined })
}

/** `files` replayed each on a session `open`ed for it, as apply gives each file an Atlas call (PA1 of r22b) */
async function replayEach(
	run: Run,
	files: readonly HistoryFile[],
	{ open, ...replay }: Replaying & { open: () => Sql },
): Promise<void> {
	for (const file of files) {
		await run.sql.end()
		run.sql = open()
		await replayFile(run, file, replay)
	}
}

/* why a replay stops on a devUrl role that cannot make the database it replays in */
const NO_CREATEDB =
	"devUrl's role cannot create a database (CREATEDB), and comb replays the history file by file, as Atlas applies it, in a database of its own on devUrl's server; grant the role CREATEDB, or point devUrl at a server where it has it"

/**
 * The replay's database made ready: counted, holding devUrl's extensions the `files` do not make, and
 * `schema` made; what makes those waiting on one a file makes
 */
async function prepare(
	run: Run,
	schema: string,
	{ files, refused, stops }: { files: readonly HistoryFile[]; refused: Refuse; stops: string },
): Promise<(sql: Sql) => Promise<void>> {
	await refuseUncounted(run.sql, stops)
	const waits = await copyExtensions(run.admin, run.sql, {
		makes: extensionsOf(files.map(({ sql: text }) => text)),
		refused: (name, error) =>
			refused(
				`devUrl's database holds the extension ${name}, which comb could not make in the database it replays the history in`,
				error,
			),
	})
	if (schema !== "public") await run.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${sqlIdentifier(schema)}`, [])
	return waits
}

/*
 * the startup settings Atlas's session applies a file on, which the replay's opens with too: Atlas's
 * driver pins DateStyle, and the target URL carries the schema, a plain name, as search_path, so a
 * RESET or DISCARD ALL returns to them and a date reads month first on any server (PR3 of r22b)
 */
const ATLAS_SESSION = { DateStyle: "ISO, MDY" } as const

/** A refusal: what failed, with devUrl's error, and what that stops */
type Refuse = (what: string, error: unknown) => ReplayFailed

/**
 * The replay's database made on `admin`'s server, and its run on it: a connection there searching
 * `target`'s schema, and how each later session opens
 */
async function opening(
	admin: Sql,
	target: PgTarget,
	{ connect, stops }: { connect: Connect; stops: string },
): Promise<{ open: () => Sql; run: Run }> {
	const { owner, settings } = await claim(admin)
	const search = { ...settings, ...ATLAS_SESSION, search_path: target.schema }
	const database = await makeDatabase(admin, owner, () => new ReplayFailed(`${NO_CREATEDB}; ${stops}`))
	const open = () => connect(replayOptions(target.devUrl, { database, settings: search }))
	const run: Run = {
		admin,
		created: [],
		database,
		ours: { rows: new Map(), writes: new Map() },
		owner,
		seen: new Map(),
		sql: open(),
		strays: { databases: [], roles: [], slots: [] },
		...(await devRoleOf(admin)),
	}
	return { open, run }
}

/**
 * `files` replayed on `target`'s dev server in a database of their own, the schema made and searched
 * first; then `after` on its connection. A statement dev refuses is named, with dev's error, as what
 * was `doing`, and then what that `stops`; what the replay or its sweep could not drop is `print`ed
 */
async function onDev<T>(
	target: PgTarget,
	files: readonly HistoryFile[],
	{
		after,
		load,
		print,
		...replay
	}: Omit<Replay, "leftOut"> & {
		after: (sql: Sql) => Promise<T>
		leftOut?: Replay["leftOut"] | undefined
		load: () => Promise<Connect>
		print: (line: string) => void
	},
): Promise<T> {
	refuseUrlProblems(target, { dev: true })
	const connect = await load()
	const failed = { field: "devUrl", url: target.devUrl, urls: [target.devUrl, target.url] } as const
	const refused: Refuse = (what, error) =>
		new ReplayFailed(`${what}: ${failureOf(error, failed)}; ${replay.stops}`, { cause: error })
	const leave = leaving(print, failed)
	let admin: Sql | undefined
	try {
		const cleanup = onceCleanup()
		return await onSignals(cleanup.run, async () => {
			admin = connect(replayOptions(target.devUrl))
			await sweep(admin, Date.now(), leave)
			const { open, run } = await opening(admin, target, { connect, stops: replay.stops })
			cleanup.set(() => cleanUp(run, leave))
			try {
				const waits = await prepare(run, target.schema, { files, refused, stops: replay.stops })
				await prepareSnapshot(admin, run)
				run.seen = await snapshot(admin)
				await replayEach(run, files, { ...replay, leftOut: replay.leftOut ?? (() => undefined), open, refused, waits })
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
	{ files, print, targetUser }: { files: readonly HistoryFile[]; print: (line: string) => void; targetUser: string },
	load: () => Promise<Connect> = () => loadPostgres(REPLAYS),
): Promise<LiveObjects> {
	return onDev(target, files, {
		after: async (sql) => asTarget(await readCatalog(sql, target.schema), targetUser),
		doing: "baseline replayed the history there",
		load,
		print,
		stops: "baseline compares nothing",
	})
}

export { type HistoryFile, onDev, replayCatalog }
