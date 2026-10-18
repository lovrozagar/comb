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
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Dialect } from "../types.ts"
import { applySqliteMigrationTransforms, SQLITE_DEV_URL } from "./atlas-env.ts"
import { explainAtlasFailure, type PgTarget, withAtlasEnv } from "./atlas-target.ts"
import { asSql, type FtsState, ftsDelta, separate } from "./fts-migration.ts"
import { splitEnumValues } from "./pg-enum-split.ts"
import { atlasDirectives, type PgObjects, pgDelta, separatePgObjects, wrapAtlasFile } from "./pg-objects.ts"
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
}

export type MigrateDiffResult = {
	files: string[]
	synced: boolean
}

type Atlas = { dialect: Dialect; exec: Run; target?: PgTarget | undefined }

function hash(atlas: Atlas, dir: string): void {
	const result = atlas.exec("atlas", ["migrate", "hash", "--dir", `file://${dir}`])
	if (result.code !== 0) throw new Error(`atlas migrate hash failed: ${result.stderr}`)
}

/** A migration to diff: its name and the schema it should reach */
type Target = { name: string; schema: string }

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
				? atlas.exec("atlas", [...args, "--dev-url", SQLITE_DEV_URL, ...format])
				: withAtlasEnv(atlas.target, { dev: true }, (env) => {
						const ran = atlas.exec("atlas", [...args, ...env.args, ...format], { env: env.env })
						return { ...ran, stderr: explainAtlasFailure(env.scrub(ran.stderr)), stdout: env.scrub(ran.stdout) }
					})
		/* in sync, Atlas exits 0, says so on stdout and writes no file: the empty list below */
		if (result.code !== 0) throw new Error(`atlas migrate diff failed: ${result.stderr || result.stdout.trim()}`)
		return readdirSync(dir).filter((file) => !before.has(file) && file !== "atlas.sum")
	} finally {
		rmSync(work, { force: true, recursive: true })
	}
}

const migrationFiles = (dir: string) =>
	readdirSync(dir)
		.filter((file) => file.endsWith(".sql"))
		.sort()

/**
 * Refuse a history whose atlas.sum does not match its files: Atlas checks this itself, but here it
 * only ever sees a fresh copy, so comb hashes an untouched copy and compares.
 */
function checkIntegrity(atlas: Atlas, dir: string): void {
	const check = mkdtempSync(join(tmpdir(), "comb-migrate-sum-"))
	try {
		for (const file of migrationFiles(dir)) copyFileSync(join(dir, file), join(check, file))
		hash(atlas, check)
		if (readFileSync(join(check, "atlas.sum"), "utf8") !== readFileSync(join(dir, "atlas.sum"), "utf8")) {
			throw new Error(
				`${dir}/atlas.sum does not match its migrations; if a migration was edited on purpose, run atlas migrate hash`,
			)
		}
	} finally {
		rmSync(check, { force: true, recursive: true })
	}
}

/** The plain-only diff on a stripped copy of the history, and the FTS delta comb adds to it */
function diffWithFts(atlas: Atlas, options: MigrateDiffOptions): MigrateDiffResult {
	checkIntegrity(atlas, options.migrationsDir)
	const groups = new Set<string>()
	const copy = mkdtempSync(join(tmpdir(), "comb-migrate-history-"))
	try {
		let history: FtsState = new Map()
		for (const file of migrationFiles(options.migrationsDir)) {
			const separated = separate(readFileSync(join(options.migrationsDir, file), "utf8"), groups, history)
			history = separated.state
			writeFileSync(join(copy, file), asSql(separated.plain))
		}
		hash(atlas, copy)
		const target = separate(options.ftsSql ?? "", groups)
		const added = atlasDiff(atlas, copy, { name: options.migrationName, schema: options.targetSchema })
		const plainDiff = added.map((file) => readFileSync(join(copy, file), "utf8")).join("\n")
		const fts = ftsDelta({ from: history, plainDiff, to: target.state, toStatements: target.fts })
		return finish({ added, atlas, copy, fts, options, plainDiff })
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
}

function finish({ added, atlas, copy, fts, options, plainDiff }: Finish): MigrateDiffResult {
	const { migrationName, migrationsDir } = options
	if (added.length === 0 && fts === "") return { files: [], synced: true }
	const name = added[0] ?? `${timestamp()}_${migrationName}.sql`
	const file = join(migrationsDir, name)
	/* only the SQLite path writes migrations itself, so the SQLite pragma rewrite always applies */
	writeFileSync(file, applySqliteMigrationTransforms(`${plainDiff}${plainDiff && fts ? "\n" : ""}${fts}`))
	for (const extra of added.slice(1)) copyFileSync(join(copy, extra), join(migrationsDir, extra))
	hash(atlas, migrationsDir)
	return { files: [file, ...added.slice(1).map((extra) => join(migrationsDir, extra))], synced: false }
}

/**
 * The Postgres diff: Atlas replays a copy of the history without the objects it refuses (each file
 * keeping its atlas: directives) and diffs it against the target without them; comb wraps the file
 * Atlas writes with those objects' part (pg-objects.ts)
 */
function diffPostgres(atlas: Atlas, options: MigrateDiffOptions): MigrateDiffResult {
	const { migrationName, migrationsDir } = options
	checkIntegrity(atlas, migrationsDir)
	const copy = mkdtempSync(join(tmpdir(), "comb-migrate-history-"))
	try {
		const history: PgObjects = new Map()
		for (const file of migrationFiles(migrationsDir)) {
			const sql = readFileSync(join(migrationsDir, file), "utf8")
			const head = atlasDirectives(sql)
			writeFileSync(join(copy, file), head + asSql(separatePgObjects(sql.slice(head.length), history).plain))
		}
		hash(atlas, copy)
		const target = separatePgObjects(options.targetSchema)
		const added = atlasDiff(atlas, copy, { name: migrationName, schema: asSql(target.plain) })
		const atlasFiles = added.map((file) => readFileSync(join(copy, file), "utf8"))
		const delta = pgDelta({ atlasSql: atlasFiles.join("\n"), from: history, to: target })
		if (added.length === 0 && delta.before.length === 0 && delta.after.length === 0) return { files: [], synced: true }
		const written = splitEnumValues(
			added[0] ?? `${timestamp()}_${migrationName}.sql`,
			wrapAtlasFile(atlasFiles[0] ?? "", delta),
		)
		for (const [name, sql] of written) writeFileSync(join(migrationsDir, name), sql)
		for (const extra of added.slice(1)) copyFileSync(join(copy, extra), join(migrationsDir, extra))
		hash(atlas, migrationsDir)
		const names = [...written.map(([name]) => name), ...added.slice(1)]
		return { files: names.map((file) => join(migrationsDir, file)), synced: false }
	} finally {
		rmSync(copy, { force: true, recursive: true })
	}
}

/** Atlas's migration file stamp: UTC YYYYMMDDHHMMSS */
const timestamp = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14)

export function generateIncrementalMigration(options: MigrateDiffOptions): MigrateDiffResult {
	const { dialect, migrationsDir, run: exec = run, target } = options
	if (dialect === "postgres" && target === undefined) {
		throw new Error("a Postgres diff needs the database's target (devUrl and schema)")
	}
	const atlas: Atlas = { dialect, exec, target: dialect === "postgres" ? target : undefined }
	if (!existsSync(migrationsDir)) mkdirSync(migrationsDir, { recursive: true })
	if (!existsSync(join(migrationsDir, "atlas.sum"))) hash(atlas, migrationsDir)
	return dialect === "sqlite" ? diffWithFts(atlas, options) : diffPostgres(atlas, options)
}
