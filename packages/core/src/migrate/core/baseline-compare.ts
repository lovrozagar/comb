/**
 * Whether a database's schema is the one its migrations leave, before `baseline` records them as
 * applied: Atlas diffs the database against the history replayed on a dev database. On SQLite comb
 * reads the database's DDL from sqlite_master through the connection, so any engine comb reaches
 * works; Atlas's dev SQLite has no fts5 module, so the FTS5 objects stay out of both sides, as in
 * a diff (fts-migration.ts), and comb compares them by name. On Postgres Atlas reads the database
 * itself, and inspects no view, policy or sequence.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ScratchEngine } from "../drivers/local-db.ts"
import type { Connection } from "../types.ts"
import { hashDir, sqlFiles } from "./atlas-dir.ts"
import { HISTORY_TABLES, notEngineTables } from "./engine-tables.ts"
import { sqliteDevUrl } from "./atlas-env.ts"
import { explainAtlasFailure } from "./atlas-failure.ts"
import { atlasNotices, type PgTarget, withAtlasEnv } from "./atlas-target.ts"
import { asSql, type FtsState, separate } from "./fts-migration.ts"
import { COMPARED, liveDrift, readLiveObjects } from "./pg-live-objects.ts"
import type { ReadyDev } from "./pg-dev-schema.ts"
import type { LiveObjects, LiveRead } from "./pg-live-types.ts"
import { extensionReplay, viewReplay } from "./pg-atlas-replay.ts"
import { atlasHeader } from "./atlas-header.ts"
import { emptyPgObjects, separatePgObjects } from "./pg-objects.ts"
import { beyondDatabase, nodeOf } from "./pg-outside-transaction.ts"
import { atlasFile, pgRead } from "./pg-split.ts"
import type { Run } from "./process.ts"
import { codeOf } from "../../sql-lexer.ts"
import { asciiFold } from "./sql-code.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { type HistoryFile, replayCatalog } from "./pg-replay.ts"
import { makesCompared } from "./pg-replay-gate.ts"
import { UNCOMPARED } from "./baseline-uncompared.ts"
import { ReplayFailed } from "./replay-failed.ts"
import { objectDrift } from "./baseline-sqlite-objects.ts"
import { isVectorIndexSql, vectorShadows, vectorStatement } from "./vector-index.ts"
import { type Scratch, scratchDir } from "./cleanup.ts"

const SYNCED = "Schemas are synced, no changes to be made."
/* the tables SQLite keeps behind a virtual table: fts5's, fts3 and fts4's, and rtree's */
const SHADOWS = ["config", "content", "data", "docsize", "idx", "node", "parent", "rowid", "segdir", "segments", "stat"]

/**
 * The database's DDL as Atlas OSS reads it: its tables and indexes, not its engine's, the shadow
 * tables of `fts` or the migration histories. Atlas OSS refuses a trigger or a view, so those stay
 * out, and a virtual table is left to `separate` and UNINSPECTED_DDL: objectDrift compares them all
 * (N-S5 of plan 15's rerun)
 */
async function liveDdl(conn: Connection): Promise<string> {
	const { rows } = await conn.execute(
		`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index')${notEngineTables(conn, HISTORY_TABLES)} ORDER BY rowid`,
	)
	/* a vector index and what libsql makes for it: no SQLite but libsql's reads them, so objectDrift compares the index (SL3 of r22) */
	const vectors = rows
		.filter(([type, , sql]) => type === "index" && isVectorIndexSql(String(sql)))
		.map((row) => String(row[1]))
	const libsqls = new Set([...vectors.map(asciiFold), ...vectorShadows(vectors)])
	return asSql(rows.filter((row) => !libsqls.has(asciiFold(String(row[1])))).map((row) => String(row[2])))
}

/* a history statement that makes or drops what Atlas OSS refuses: a trigger, a view, a virtual table, which objectDrift compares */
const UNINSPECTED_DDL =
	/^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(?:CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:TRIGGER|VIEW|VIRTUAL\s+TABLE)|DROP\s+(?:TRIGGER|VIEW))\b/i

/**
 * The difference between the database's schema and the one the migrations of `dir` leave, as the
 * SQL that would bring the database there; "" when they agree. The history replays on `engine`, the
 * SQLite its files apply on (SL3 of r22).
 */
async function sqliteDrift(
	conn: Connection,
	dir: string,
	{ engine = "runtime", exec }: { engine?: ScratchEngine | undefined; exec: Run },
): Promise<string> {
	const { dir: work, remove: removeWork } = scratchDir("comb-baseline-")
	try {
		const groups = new Set<string>()
		const vectors = new Set<string>()
		const copy = join(work, "history")
		let history: FtsState = new Map()
		mkdirSync(copy)
		for (const file of sqlFiles(dir)) {
			const separated = separate(readFileSync(join(dir, file), "utf8"), groups, history)
			history = separated.state
			writeFileSync(
				join(copy, file),
				asSql(separated.plain.filter((stmt) => !UNINSPECTED_DDL.test(stmt) && !vectorStatement(stmt, vectors))),
			)
		}
		await hashDir(exec, copy)
		const live = separate(await liveDdl(conn), groups)
		/* every virtual table's shadows, the database's own included: Atlas would read them as tables (N-S5) */
		const virtual = await conn.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
		)
		const owners = [...groups, ...virtual.rows.map((row) => String(row[0]))]
		const shadows = new Set(owners.flatMap((owner) => SHADOWS.map((suffix) => `${owner}_${suffix}`)))
		const plain = live.plain.filter((stmt) => {
			if (UNINSPECTED_DDL.test(stmt)) return false
			const table = /^\s*CREATE TABLE ['"`[]?(\w+)/i.exec(stmt)?.[1]
			return table === undefined || !shadows.has(table)
		})
		writeFileSync(join(work, "live.sql"), asSql(plain))
		const args = ["schema", "diff", "--from", `file://${join(work, "live.sql")}`, "--to", `file://${copy}`]
		const ran = await exec("atlas", [...args, "--dev-url", sqliteDevUrl()])
		if (ran.code !== 0) throw new Error(`atlas schema diff failed: ${`${ran.stderr}${ran.stdout}`.trim()}`)
		const atlasDiff = ran.stdout.trim() === SYNCED ? [] : [ran.stdout.trim()]
		return [...atlasDiff, ...(await objectDrift(conn, dir, engine))].join("\n")
	} finally {
		removeWork()
	}
}

/**
 * The snapshot's history as Atlas can replay it on the dev database: without the objects comb
 * owns but its sequences, which a table's default may use and Atlas never inspects, and without a
 * statement whose scope is the server or another database, in a scratch the caller removes; one
 * this fails to write is removed here
 */
async function replayableHistory(exec: Run, copy: string): Promise<Scratch> {
	const scratch = scratchDir("comb-baseline-history-")
	try {
		writeReplayable(scratch.dir, copy)
		await hashDir(exec, scratch.dir)
		return scratch
	} catch (error) {
		scratch.remove()
		throw error
	}
}

/** Each file of `copy` into `plain`, as replayableHistory has Atlas replay it */
function writeReplayable(plain: string, copy: string): void {
	const state = emptyPgObjects()
	for (const name of sqlFiles(copy)) {
		const sql = readFileSync(join(copy, name), "utf8")
		/* the statements Postgres runs, written back so Atlas sends each alone (M75) */
		const kept = new Set(separatePgObjects(sql, state, name).plain)
		/* a view and an extension replay in place, inside DO blocks, so what depends on them replays too (P4 of r19) */
		const replayed = pgRead(sql).statements.flatMap(({ text: stmt, tree }) => {
			/* Atlas commits what it replays on devUrl's server: nothing past the database it replays in (P1 of r20) */
			if (tree !== undefined && beyondDatabase(...nodeOf(tree)) !== undefined) return []
			const code = codeOf(stmt, "postgres")
			if (kept.has(stmt) || /^(?:CREATE|ALTER|DROP) SEQUENCE\b/i.test(code)) return [stmt]
			const block = viewReplay(stmt, code) ?? extensionReplay(stmt, code)
			return block === undefined ? [] : [block]
		})
		writeFileSync(join(plain, name), atlasFile(replayed, atlasHeader(sql).text))
	}
}

/**
 * Refuses a database whose tables are not the ones the migrations leave: Atlas diffs the database
 * against the history replayed on the dev database. Atlas OSS inspects no view, policy or
 * sequence, so those are not compared.
 */
async function refuseDrift(
	options: { exec: Run; target: PgTarget },
	copy: string,
	refusal?: string,
): Promise<string[]> {
	const plain = await replayableHistory(options.exec, copy)
	try {
		const ran = await withAtlasEnv(options.target, { dev: true, url: true }, async (env) => {
			const args = ["schema", "diff", "--from", "env://url", "--to", `file://${plain.dir}`, ...env.args]
			const result = await options.exec("atlas", args, { env: env.env })
			/* compared as Atlas wrote it; scrubbed only in what comb prints (M79) */
			if (result.code !== 0) {
				const said = `${explainAtlasFailure(result.stderr, env.scrub)}${env.scrub(result.stdout)}`
				throw new ReplayFailed(`atlas schema diff: ${said.trim()}`)
			}
			return {
				notices: atlasNotices(env.scrub(result.stderr)),
				stdout: result.stdout.trim(),
				shown: env.scrub(result.stdout).trim(),
			}
		})
		if (ran.stdout !== SYNCED) {
			throw new Error(
				`${refusal ?? "the database's tables are not the ones the migrations leave, so baseline records nothing"}; the difference:\n${ran.shown}`,
			)
		}
		return ran.notices
	} finally {
		plain.remove()
	}
}

/** How a Postgres baseline reads the database's functions, procedures and triggers: postgres.js unless a test says otherwise */
type ObjectsCompare = {
	print(line: string): void
	readLive?: LiveRead | undefined
	/** how the history's replay on dev is read: comb's own (pg-replay.ts) unless a test says otherwise */
	readReplay?: typeof replayCatalog | undefined
	/** how the dev database gets the target schema before a replay: comb's own unless a test says otherwise (P12) */
	readyDev?: ReadyDev | undefined
	target: PgTarget
}

/**
 * Refuses a database whose functions, procedures or triggers are not, by name, the ones the
 * migrations of `copy` leave in the target schema, which Atlas OSS leaves out of refuseDrift's
 * comparison without a word (plan 14's 5.4b). It replays and reads before Atlas runs on dev, and
 * returns its verdict for after Atlas's comparison, so a table's difference is still named first:
 * the warnings to print (the bodies of those that match were not compared), or the refusal
 */
/**
 * What the history `files` leave of what the catalog read compares, read from their replay on dev
 * (P5 of r19). A docker:// dev is Atlas's own container, which comb cannot reach: a history that
 * makes nothing compared leaves nothing, and any other is refused naming devUrl
 */
async function historyCatalog(
	options: ObjectsCompare,
	files: readonly HistoryFile[],
	user: string,
): Promise<LiveObjects> {
	if (!options.target.devUrl.startsWith("docker:"))
		return (options.readReplay ?? replayCatalog)(options.target, { files, print: options.print, targetUser: user })
	if (makesCompared(files)) {
		throw new ReplayFailed(
			`baseline compares the database's ${COMPARED} with the history replayed on devUrl, which comb reads itself, and ${options.target.devUrl} is Atlas's own container, which comb cannot reach: set devUrl to a postgres:// scratch database comb can connect to (it replays the history there file by file, in a database of its own)`,
		)
	}
	return { ...emptyCatalog(), user }
}

/** What the catalog read finds in a schema the history leaves nothing in */
const emptyCatalog = (): LiveObjects => ({
	extensions: new Set(),
	kinds: new Map(),
	others: new Set(),
	platform: new Set(),
	policies: new Map(),
	relations: new Map(),
	rls: new Map(),
	routines: new Map(),
	rules: new Map(),
	sequences: new Map(),
	triggers: new Map(),
	user: "",
})

async function refuseObjectDrift(options: ObjectsCompare, copy: string, refusal?: string): Promise<() => string[]> {
	/* the replay reads each file as Postgres's parser does */
	await loadPostgresParser()
	const files = sqlFiles(copy).map((name) => ({ name, sql: readFileSync(join(copy, name), "utf8") }))
	const live = await (options.readLive ?? readLiveObjects)(options.target)
	const { matched, only: differ } = liveDrift(await historyCatalog(options, files, live.user), live)
	if (differ.length > 0) {
		const refused = new Error(
			`${refusal ?? `the database's ${COMPARED} are not the ones the migrations leave, so baseline records nothing`}:\n${differ.join("\n")}`,
		)
		return () => {
			throw refused
		}
	}
	const counted = [
		...(matched.routines === 0 ? [] : [`${matched.routines} function${matched.routines === 1 ? "" : "s"}`]),
		...(matched.triggers === 0 ? [] : [`${matched.triggers} trigger${matched.triggers === 1 ? "" : "s"}`]),
		...(matched.views === 0 ? [] : [`${matched.views} view${matched.views === 1 ? "" : "s"}`]),
	]
	/* P10 of r18: what neither comparison reads, said every time, as a database may differ there unseen */
	return () => [
		...(counted.length === 0
			? []
			: [
					`Warning: the bodies of ${counted.join(" and ")} were not compared: Atlas OSS cannot load them, and comb does not read them`,
				]),
		UNCOMPARED,
	]
}

export { type ObjectsCompare, refuseDrift, refuseObjectDrift, ReplayFailed, sqliteDrift, UNCOMPARED }
