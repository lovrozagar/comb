/**
 * Incremental migrations through `atlas migrate diff`: Atlas replays the migrations directory on
 * a dev database, diffs the result against the target schema, and emits only the delta.
 *
 * Atlas works on a temporary copy of the history with what it cannot handle stripped, against a
 * target without it, and comb writes that part itself: on SQLite the FTS5 objects (its dev SQLite
 * has no fts5 module; fts-migration.ts), on Postgres the views, policies, sequences, roles and
 * extensions Atlas OSS refuses (pg-objects.ts).
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Dialect } from "../types.ts"
import { freshVersion, hashDir, nextVersion, sqlFiles, verifySum } from "./atlas-dir.ts"
import { applySqliteMigrationTransforms, sqliteDevUrl } from "./atlas-env.ts"
import { explainAtlasFailure } from "./atlas-failure.ts"
import { atlasNotices, type PgTarget, withAtlasEnv } from "./atlas-target.ts"
import { asSql, type FtsState, ftsDelta, separate } from "./fts-migration.ts"
import { splitEnumValues } from "./pg-enum-split.ts"
import { extractSchema } from "./schema.ts"
import { readyDevSchema } from "./pg-dev-schema.ts"
import { devPrelude, emptyPgObjects, pgDelta, separatePgObjects, wrapAtlasFile } from "./pg-objects.ts"
import { atlasDirectives, atlasFile, pgStatements } from "./pg-split.ts"
import { type Run, run } from "./process.ts"

export type MigrateDiffOptions = {
	dialect: Dialect
	/** SQLite: the target's FTS5 DDL, kept apart from `targetSchema` because Atlas cannot load it */
	ftsSql?: string | undefined
	migrationName: string
	migrationsDir: string
	targetSchema: string
	/** The process runner; tests pass a fake. */
	run?: Run | undefined
	/** Postgres: the database's dev database and schema Atlas diffs in */
	target?: PgTarget | undefined
	/** Postgres: how the dev database gets the target schema, comb's own unless a test fakes it (P12) */
	readyDev?: ((target: PgTarget) => Promise<void>) | undefined
}

export type MigrateDiffResult = {
	files: string[]
	/** what Atlas said on stderr as it succeeded, a line each, for the caller to warn with */
	notices: string[]
	synced: boolean
}

/** A diff's own result, before the notices Atlas gave along the way join it */
type Diffed = Omit<MigrateDiffResult, "notices">

/** How a diff runs Atlas, and what Atlas said as it succeeded */
type Atlas = { dialect: Dialect; exec: Run; notices: string[]; target?: PgTarget | undefined }

/** A migration to diff: its name and the schema it should reach */
type Target = { name: string; schema: string }

const VERSION = /^(\d{14})(_.*)$/

/**
 * `added`, renamed in `dir` so each version comes after the history's latest and the one before it:
 * Atlas stamps a file with the current second, so a second diff in one second, or a history a
 * teammate's clock stamped ahead, would otherwise sort it among or before files already there
 */
function afterHistory(dir: string, history: readonly string[], added: readonly string[]): string[] {
	let last = history
		.map((file) => VERSION.exec(file)?.[1])
		.filter((version) => version !== undefined)
		.sort()
		.at(-1)
	return added.map((file) => {
		const [, version, rest] = VERSION.exec(file) ?? []
		if (version === undefined) return file
		const next = last !== undefined && version <= last ? nextVersion(last) : version
		last = next
		if (next === version) return file
		renameSync(join(dir, file), join(dir, `${next}${rest}`))
		return `${next}${rest}`
	})
}

/** The files `atlas migrate diff` adds to `dir` for the target; none when it is in sync */
function atlasDiff(atlas: Atlas, dir: string, { name, schema }: Target): string[] {
	const work = mkdtempSync(join(tmpdir(), "comb-migrate-diff-"))
	try {
		const target = join(work, "schema.sql")
		writeFileSync(target, schema)
		const before = new Set(readdirSync(dir))
		const args = ["migrate", "diff", name, "--dir", `file://${dir}`, "--to", `file://${target}`]
		const format = ["--format", "{{ sql . }}"]
		const result =
			atlas.target === undefined
				? atlas.exec("atlas", [...args, "--dev-url", sqliteDevUrl(), ...format])
				: withAtlasEnv(atlas.target, { dev: true }, (env) => {
						const ran = atlas.exec("atlas", [...args, ...env.args, ...format], { env: env.env })
						/* diff gives Atlas the dev database alone: a database not clean is the dev's (P3) */
						const stderr = explainAtlasFailure(ran.stderr, env.scrub, { devOnly: true })
						return { ...ran, stderr, stdout: env.scrub(ran.stdout) }
					})
		/* in sync, Atlas exits 0, says so on stdout and writes no file: the empty list below */
		if (result.code !== 0) throw new Error(`atlas migrate diff failed: ${result.stderr || result.stdout.trim()}`)
		atlas.notices.push(...atlasNotices(result.stderr))
		/* sorted: readdir order is the filesystem's (APFS returns no fixed order), and the first file carries the migration */
		const added = readdirSync(dir)
			.filter((file) => !before.has(file) && file !== "atlas.sum")
			.sort()
		return afterHistory(dir, [...before], added)
	} finally {
		rmSync(work, { force: true, recursive: true })
	}
}

/** The plain-only diff on a stripped copy of the history, and the FTS delta comb adds to it */
function diffWithFts(atlas: Atlas, options: MigrateDiffOptions): Diffed {
	verifySum(atlas.exec, options.migrationsDir)
	const groups = new Set<string>()
	const copy = mkdtempSync(join(tmpdir(), "comb-migrate-history-"))
	try {
		let history: FtsState = new Map()
		/* the schema the whole history leaves, FTS triggers included, which the rebuild guard reads */
		let before = extractSchema("")
		for (const file of sqlFiles(options.migrationsDir)) {
			const sql = readFileSync(join(options.migrationsDir, file), "utf8")
			const separated = separate(sql, groups, history)
			history = separated.state
			before = extractSchema(sql, before)
			writeFileSync(join(copy, file), asSql(separated.plain))
		}
		hashDir(atlas.exec, copy)
		const target = separate(options.ftsSql ?? "", groups)
		const added = atlasDiff(atlas, copy, { name: options.migrationName, schema: options.targetSchema })
		const plainDiff = added.map((file) => readFileSync(join(copy, file), "utf8")).join("\n")
		const fts = ftsDelta({ from: history, plainDiff, to: target.state, toStatements: target.fts })
		const transform = (sql: string) => applySqliteMigrationTransforms(sql, before, history)
		return finish({ added, atlas, copy, fts, options, plainDiff, transform })
	} finally {
		rmSync(copy, { force: true, recursive: true })
	}
}

type Finish = {
	added: string[]
	atlas: Atlas
	copy: string
	fts: string
	options: MigrateDiffOptions
	plainDiff: string
	/** the SQLite rewrite of what comb writes: the pragma swap and the rebuild guard */
	transform: (sql: string) => string
}

function finish({ added, atlas, copy, fts, options, plainDiff, transform }: Finish): Diffed {
	const { migrationName, migrationsDir } = options
	if (added.length === 0 && fts === "") return { files: [], synced: true }
	const name = added[0] ?? `${freshVersion(migrationsDir)}_${migrationName}.sql`
	const file = join(migrationsDir, name)
	/* rewritten before anything is written, so a rebuild the guard refuses leaves the directory as it was */
	const sql = transform(`${plainDiff}${plainDiff && fts ? "\n" : ""}${fts}`)
	writeFileSync(file, sql)
	for (const extra of added.slice(1)) copyFileSync(join(copy, extra), join(migrationsDir, extra))
	hashDir(atlas.exec, migrationsDir)
	return { files: [file, ...added.slice(1).map((extra) => join(migrationsDir, extra))], synced: false }
}

/**
 * The Postgres diff: Atlas replays a copy of the history without the objects it refuses (each file
 * keeping its atlas: directives) and diffs it against the target without them; comb wraps the file
 * Atlas writes with those objects' part (pg-objects.ts)
 */
function diffPostgres(atlas: Atlas, options: MigrateDiffOptions): Diffed {
	const { migrationName, migrationsDir } = options
	verifySum(atlas.exec, migrationsDir)
	const copy = mkdtempSync(join(tmpdir(), "comb-migrate-history-"))
	try {
		const history = emptyPgObjects()
		const plain = sqlFiles(migrationsDir).map((file) => {
			const sql = readFileSync(join(migrationsDir, file), "utf8")
			return { file, head: atlasDirectives(sql), plain: separatePgObjects(sql, history, file).plain }
		})
		const target = separatePgObjects(options.targetSchema)
		/* the dev database gets the sequences and extensions a table may need first, in the copy's first file and the target */
		const prelude = devPrelude(history, target.state)
		/* each written back so Atlas sends each statement alone, as Postgres runs it (M75) */
		for (const [i, { file, head, plain: kept }] of plain.entries())
			writeFileSync(join(copy, file), atlasFile([...(i === 0 ? pgStatements(prelude) : []), ...kept], head))
		hashDir(atlas.exec, copy)
		const added = atlasDiff(atlas, copy, { name: migrationName, schema: prelude + asSql(target.plain) })
		const atlasFiles = added.map((file) => readFileSync(join(copy, file), "utf8"))
		const delta = pgDelta({ atlasSql: atlasFiles.join("\n"), from: history, to: target })
		if (added.length === 0 && delta.before.length === 0 && delta.after.length === 0) return { files: [], synced: true }
		const written = splitEnumValues(
			added[0] ?? `${freshVersion(migrationsDir)}_${migrationName}.sql`,
			wrapAtlasFile(atlasFiles[0] ?? "", delta),
		)
		for (const [name, sql] of written) writeFileSync(join(migrationsDir, name), sql)
		for (const extra of added.slice(1)) copyFileSync(join(copy, extra), join(migrationsDir, extra))
		hashDir(atlas.exec, migrationsDir)
		const names = [...written.map(([name]) => name), ...added.slice(1)]
		return { files: names.map((file) => join(migrationsDir, file)), synced: false }
	} finally {
		rmSync(copy, { force: true, recursive: true })
	}
}

export async function generateIncrementalMigration(options: MigrateDiffOptions): Promise<MigrateDiffResult> {
	const { dialect, migrationsDir, run: exec = run, target } = options
	if (dialect === "postgres" && target === undefined) {
		throw new Error("a Postgres diff needs the database's target (devUrl and schema)")
	}
	/* Atlas replays the history on the dev database, inspecting the target schema there first (P12) */
	if (dialect === "postgres") await (options.readyDev ?? readyDevSchema)(target as PgTarget)
	const atlas: Atlas = { dialect, exec, notices: [], target: dialect === "postgres" ? target : undefined }
	if (!existsSync(migrationsDir)) mkdirSync(migrationsDir, { recursive: true })
	if (!existsSync(join(migrationsDir, "atlas.sum"))) hashDir(atlas.exec, migrationsDir)
	const diffed = dialect === "sqlite" ? diffWithFts(atlas, options) : diffPostgres(atlas, options)
	return { ...diffed, notices: atlas.notices }
}
