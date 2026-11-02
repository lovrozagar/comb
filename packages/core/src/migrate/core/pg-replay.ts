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
 * none (pg-outside-transaction.ts) and says which it left out; a CREATE ROLE runs, as a policy needs
 * its role, and comb drops each role it made.
 */
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import { maskSecrets } from "./atlas-secrets.ts"
import { type PgTarget, refuseUrlProblems } from "./atlas-target.ts"
import { outsideTransaction } from "./classify-file.ts"
import { ReplayFailed } from "./replay-failed.ts"
import { type Connect, failureOf, loadPostgres, readCatalog } from "./pg-live-objects.ts"
import type { LiveObjects } from "./pg-live-types.ts"
import { beyondDatabase, nodeOf } from "./pg-outside-transaction.ts"
import { copyExtensions, createRole, dropRole, makeDatabase, type Sql, sweep } from "./pg-replay-database.ts"
import { pgRead } from "./pg-split.ts"
import { postgresOptionsOf } from "./pg-url.ts"

/** A history file as baseline reads it */
type HistoryFile = { name: string; sql: string }

/* why comb loads postgres.js here */
const REPLAYS = "baseline replays the history on devUrl, and reads what it leaves, through the `postgres` package"

/** How the replay words what it does, and where it says what it left out */
type Replay = {
	/** what the replay was doing, as a refusal names it */
	doing: string
	/** a statement left out, from `file`, and what it is */
	leftOut(file: string, sent: string, what: string): void
	/** what a refusal stops */
	stops: string
}

/** One replay's state: its connection, its database, when it started and the roles it made */
type Run = { created: string[]; database: string; sql: Sql; started: number }

/** `file` run as Atlas applies it: in a transaction of its own unless `-- atlas:txmode none` gives it up */
async function replayFile(run: Run, { name, sql: text }: HistoryFile, replay: Replay & { refused: Refuse }) {
	const inFile = !outsideTransaction(text)
	if (inFile) await run.sql.unsafe("BEGIN", [])
	for (const { sent, tree } of pgRead(text).statements) {
		const [type, node] = tree === undefined ? ["", {}] : nodeOf(tree)
		const beyond = beyondDatabase(type, node)
		if (beyond !== undefined) {
			replay.leftOut(name, sent, beyond)
			continue
		}
		try {
			if (type !== "CreateRoleStmt") await run.sql.unsafe(sent, [])
			else {
				const role = String(node["role"])
				if (await createRole(run.sql, { ...run, inFile, role, sent })) run.created.push(role)
			}
		} catch (error) {
			throw replay.refused(`${name}: devUrl refused ${JSON.stringify(sent)} as ${replay.doing}`, error)
		}
	}
	if (inFile) await run.sql.unsafe("COMMIT", [])
}

/* why a replay stops on a devUrl role that cannot make the database it replays in */
const NO_CREATEDB =
	"devUrl's role cannot create a database (CREATEDB), and comb replays the history file by file, as Atlas applies it, in a database of its own on devUrl's server; grant the role CREATEDB, or point devUrl at a server where it has it"

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
	const scrub = (text: string) => maskSecrets(text, [target.devUrl, target.url])
	const refused: Refuse = (what, error) =>
		new ReplayFailed(`${what}: ${scrub(failureOf(error, "devUrl", target.devUrl))}; ${replay.stops}`, { cause: error })
	const options = { ...postgresOptionsOf(target.devUrl, "devUrl"), max: 1, onnotice: () => undefined }
	const started = Date.now()
	let admin: Sql | undefined
	try {
		admin = connect(options)
		await sweep(admin, started)
		const database = await makeDatabase(admin, started, () => new ReplayFailed(`${NO_CREATEDB}; ${replay.stops}`))
		const run: Run = { created: [], database, sql: connect({ ...options, database }), started }
		try {
			await copyExtensions(admin, run.sql, (name, error) =>
				refused(
					`devUrl's database holds the extension ${name}, which comb could not make in the database it replays the history in`,
					error,
				),
			)
			if (target.schema !== "public")
				await run.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${sqlIdentifier(target.schema)}`, [])
			await run.sql.unsafe(`SET search_path TO ${sqlIdentifier(target.schema)}`, [])
			for (const file of files)
				await replayFile(run, file, { ...replay, leftOut: replay.leftOut ?? (() => undefined), refused })
			return await after(run.sql)
		} finally {
			await run.sql.end()
			await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`, [])
			for (const role of run.created) await dropRole(admin, role)
		}
	} catch (error) {
		if (error instanceof ReplayFailed) throw error
		throw new ReplayFailed(
			`comb could not replay the history on devUrl: ${scrub(failureOf(error, "devUrl", target.devUrl))}`,
			{
				cause: error,
			},
		)
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

/** `live` read on dev, with dev's role named as the target's wherever a policy names it (the reviewer's addition A) */
function asTarget(live: LiveObjects, targetUser: string): LiveObjects {
	const devUser = live.user
	if (devUser === targetUser) return live
	const spelled = /^(for \w+, to )(.*)(, (?:permissive|restrictive))$/
	const policies = new Map(
		[...live.policies].map(([table, each]) => [
			table,
			new Map(
				[...each].map(([name, how]) => {
					/* the catalog read spells every policy so (pg-live-catalog.ts) */
					const [, head, roles, tail] = spelled.exec(how) as RegExpExecArray as unknown as [
						string,
						string,
						string,
						string,
					]
					const mapped = roles
						.split(", ")
						.map((role) => (role === devUser ? targetUser : role))
						.sort()
					return [name, `${head}${mapped.join(", ")}${tail}`]
				}),
			),
		]),
	)
	return { ...live, policies, user: targetUser }
}

export { type HistoryFile, onDev, replayCatalog }
