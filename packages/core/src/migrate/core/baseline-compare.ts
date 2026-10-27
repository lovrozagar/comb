/**
 * Whether a database's schema is the one its migrations leave, before `baseline` records them as
 * applied: Atlas diffs the database against the history replayed on a dev database. On SQLite comb
 * reads the database's DDL from sqlite_master through the connection, so any engine comb reaches
 * works; Atlas's dev SQLite has no fts5 module, so the FTS5 objects stay out of both sides, as in
 * a diff (fts-migration.ts), and comb compares them by name. On Postgres Atlas reads the database
 * itself, and inspects no view, policy or sequence.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Connection } from "../types.ts"
import { hashDir, sqlFiles } from "./atlas-dir.ts"
import { sqliteDevUrl } from "./atlas-env.ts"
import { explainAtlasFailure, type PgTarget, withAtlasEnv } from "./atlas-target.ts"
import { asSql, type FtsState, separate } from "./fts-migration.ts"
import { emptyPgObjects, separatePgObjects } from "./pg-objects.ts"
import { atlasDirectives, atlasFile, pgStatements } from "./pg-split.ts"
import type { Run } from "./process.ts"
import { codeOf } from "./sql-code.ts"

const SYNCED = "Schemas are synced, no changes to be made."
/* the tables SQLite keeps behind every fts5 table */
const SHADOWS = ["config", "content", "data", "docsize", "idx"]

/** The database's DDL: every object but SQLite's own, the shadow tables of `fts`, and the migration histories */
async function liveDdl(conn: Connection): Promise<string> {
	const { rows } = await conn.execute(
		"SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT IN ('__drizzle_migrations', 'd1_migrations', '_cf_KV') ORDER BY rowid",
	)
	return asSql(rows.map((row) => String(row[1])))
}

/** The FTS objects `a` has and `b` lacks, as lines of the difference */
const only = (a: FtsState, b: FtsState, where: string): string[] =>
	[...a.keys()].filter((name) => !b.has(name)).map((name) => `-- FTS ${a.get(name)?.kind} ${name}: only in ${where}`)

/** The FTS objects only one side has, as lines of the difference */
function ftsDifference(live: FtsState, history: FtsState): string[] {
	return [...only(live, history, "the database"), ...only(history, live, "the migrations")]
}

/**
 * The difference between the database's schema and the one the migrations of `dir` leave, as the
 * SQL that would bring the database there; "" when they agree
 */
async function sqliteDrift(conn: Connection, dir: string, exec: Run): Promise<string> {
	const work = mkdtempSync(join(tmpdir(), "comb-baseline-"))
	try {
		const groups = new Set<string>()
		const copy = join(work, "history")
		let history: FtsState = new Map()
		mkdirSync(copy)
		for (const file of sqlFiles(dir)) {
			const separated = separate(readFileSync(join(dir, file), "utf8"), groups, history)
			history = separated.state
			writeFileSync(join(copy, file), asSql(separated.plain))
		}
		hashDir(exec, copy)
		const live = separate(await liveDdl(conn), groups)
		const shadows = new Set([...groups].flatMap((group) => SHADOWS.map((suffix) => `${group}_${suffix}`)))
		const plain = live.plain.filter((stmt) => {
			const table = /^\s*CREATE TABLE ['"`[]?(\w+)/i.exec(stmt)?.[1]
			return table === undefined || !shadows.has(table)
		})
		writeFileSync(join(work, "live.sql"), asSql(plain))
		const args = ["schema", "diff", "--from", `file://${join(work, "live.sql")}`, "--to", `file://${copy}`]
		const ran = exec("atlas", [...args, "--dev-url", sqliteDevUrl()])
		if (ran.code !== 0) throw new Error(`atlas schema diff failed: ${`${ran.stderr}${ran.stdout}`.trim()}`)
		const atlasDiff = ran.stdout.trim() === SYNCED ? [] : [ran.stdout.trim()]
		return [...atlasDiff, ...ftsDifference(live.state, history)].join("\n")
	} finally {
		rmSync(work, { force: true, recursive: true })
	}
}

/**
 * The snapshot's history as Atlas can replay it on the dev database: without the objects comb
 * owns but its sequences, which a table's default may use and Atlas never inspects
 */
function replayableHistory(exec: Run, copy: string): string {
	const plain = mkdtempSync(join(tmpdir(), "comb-baseline-history-"))
	const state = emptyPgObjects()
	for (const name of sqlFiles(copy)) {
		const sql = readFileSync(join(copy, name), "utf8")
		/* the statements Postgres runs, written back so Atlas sends each alone (M75) */
		const kept = new Set(separatePgObjects(sql, state, name).plain)
		const replayed = pgStatements(sql).filter(
			(stmt) => kept.has(stmt) || /^(?:CREATE|ALTER|DROP) SEQUENCE\b/i.test(codeOf(stmt, "postgres")),
		)
		writeFileSync(join(plain, name), atlasFile(replayed, atlasDirectives(sql)))
	}
	hashDir(exec, plain)
	return plain
}

/**
 * Refuses a database whose tables are not the ones the migrations leave: Atlas diffs the database
 * against the history replayed on the dev database. Atlas OSS inspects no view, policy or
 * sequence, so those are not compared.
 */
function refuseDrift(options: { exec: Run; target: PgTarget }, copy: string): void {
	const plain = replayableHistory(options.exec, copy)
	try {
		const ran = withAtlasEnv(options.target, { dev: true, url: true }, (env) => {
			const args = ["schema", "diff", "--from", "env://url", "--to", `file://${plain}`, ...env.args]
			const result = options.exec("atlas", args, { env: env.env })
			/* compared as Atlas wrote it; scrubbed only in what comb prints (M79) */
			if (result.code !== 0) {
				const said = `${explainAtlasFailure(env.scrub(result.stderr))}${env.scrub(result.stdout)}`
				throw new Error(`atlas schema diff: ${said.trim()}`)
			}
			return { stdout: result.stdout.trim(), shown: env.scrub(result.stdout).trim() }
		})
		if (ran.stdout !== SYNCED) {
			throw new Error(
				`the database's tables are not the ones the migrations leave, so baseline records nothing; the difference:\n${ran.shown}`,
			)
		}
	} finally {
		rmSync(plain, { force: true, recursive: true })
	}
}

export { refuseDrift, sqliteDrift }
