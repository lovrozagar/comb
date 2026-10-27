/**
 * `comb migrate apply` on Postgres: Atlas applies, comb decides what may run. Everything reads a
 * private snapshot of the migrations directory (atlas-dir.ts), so Atlas executes exactly the bytes
 * comb classified. In order: Atlas's status, which must report no error except a file it ran
 * halfway outside a transaction; a dry run, so a database that needs a baseline fails before anyone
 * is asked (a check of a database with no history inspects it instead, atlas-clean.ts); each pending file classified and approved (approval.ts); then the apply. comb passes no
 * flag that would skip a check (--exec-order, --allow-dirty, --tx-mode, --baseline) and no amount.
 */
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { ParsedMigration } from "../types.ts"
import type { Approval } from "./approval.ts"
import { snapshotDir, sqlFiles, sumHashes } from "./atlas-dir.ts"
import { refuseUnclean } from "./atlas-clean.ts"
import { explainAtlasFailure, type PgTarget, withAtlasEnv } from "./atlas-target.ts"
import { refuseDrift } from "./baseline-compare.ts"
import { extractSchema, parseMigration } from "./parse.ts"
import { type Run, type RunResult, run } from "./process.ts"
import { Refused } from "./refused.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { fileUnreadable } from "./pg-split.ts"

/** A migration file as Atlas lists it */
type AtlasFile = { Description: string; Name: string; Version: string }

/** A revision Atlas recorded: how many of the file's statements ran, and where it failed */
type AtlasRevision = {
	applied: number
	error: string
	errorStmt: string
	hash: string
	total: number
	type: string
	version: string
}

/** What `atlas migrate status` reports, read through a template that never selects the URL */
type AtlasStatus = {
	applied: AtlasRevision[]
	available: AtlasFile[]
	current: string
	error: string
	pending: AtlasFile[]
	status: string
}

const STATUS_FORMAT =
	'{"status":{{ json .Status }},"current":{{ json .Current }},"available":{{ json .Available }},"pending":{{ json .Pending }},' +
	'"applied":[{{ range $i, $r := .Applied }}{{ if $i }},{{ end }}{"version":{{ json $r.Version }},"type":{{ json $r.Type }},' +
	'"applied":{{ json $r.Applied }},"total":{{ json $r.Total }},"error":{{ json $r.Error }},"errorStmt":{{ json $r.ErrorStmt }},' +
	'"hash":{{ json $r.Hash }}}{{ end }}],"error":{{ json .Error }}}'
const APPLY_FORMAT = '{"target":{{ json .Target }},"applied":{{ json .Applied }},"error":{{ json .Error }}}'

/** What every Atlas command on a Postgres database needs: the directory, the target, and where to report */
type AtlasCommand = {
	dir: string
	/** The process runner; tests pass a fake. */
	exec?: Run | undefined
	print(line: string): void
	target: PgTarget
}

type ApplyOptions = AtlasCommand & {
	/** whether a classified migration may run: approval.ts's rule, asking a person when it must */
	approve(migration: ParsedMigration): Promise<Approval>
	/** only check: stop once every pending file is approved, applying nothing */
	checkOnly?: boolean | undefined
}

/** `atlas migrate <args>` on the snapshot `copy` against the target, its output scrubbed */
function atlas(options: AtlasCommand, copy: string, args: readonly string[]): RunResult {
	return withAtlasEnv(options.target, { url: true }, (env) => {
		const ran = (options.exec ?? run)("atlas", ["migrate", ...args, "--dir", `file://${copy}`, ...env.args], {
			env: env.env,
		})
		return { ...ran, stderr: explainAtlasFailure(env.scrub(ran.stderr)), stdout: env.scrub(ran.stdout) }
	})
}

/** `text` parsed as `command`'s JSON, or an error that does not echo what Atlas printed */
function json<T>(text: string, command: string): T {
	try {
		return JSON.parse(text) as T
	} catch {
		// reason: unreadable output may hold anything Atlas printed, so it is not repeated
		throw new Error(`unexpected output from atlas migrate ${command}`)
	}
}

const NO_HISTORY: AtlasStatus = { applied: [], available: [], current: "", error: "", pending: [], status: "PENDING" }

/**
 * Atlas's status for the snapshot `copy`. With `allowNotClean`, a database that has objects but no
 * history reads as having none recorded: Atlas refuses its status once a refused apply left an
 * empty history table, and that database is the one baseline is for.
 */
function atlasStatus(options: AtlasCommand, copy: string, allowNotClean = false): AtlasStatus {
	const ran = atlas(options, copy, ["status", "--format", STATUS_FORMAT])
	if (ran.code !== 0 && allowNotClean && ran.stderr === explainAtlasFailure("connected database is not clean"))
		return NO_HISTORY
	if (ran.code !== 0) throw new Error(`atlas migrate status: ${ran.stderr || `exit ${ran.code}: ${ran.stdout}`}`)
	return json<AtlasStatus>(ran.stdout, "status")
}

/** The file of `version` in the snapshot */
const fileOf = (copy: string, version: string) =>
	sqlFiles(copy).find((name) => name.startsWith(`${version}_`)) ?? version

/**
 * A history Atlas reports no error for may proceed. So may a file Atlas ran halfway outside a
 * transaction, if it is unchanged: Atlas resumes it by statement count, so an edit would shift
 * which statements it skips. Returns where that file stopped, if one did.
 */
/**
 * Refuses an applied file edited since, as comb does on SQLite: Atlas never runs it again, so the
 * database does not hold what the file now says, and later files would be classified against it
 */
function refuseEdited(status: AtlasStatus, copy: string): void {
	const hashes = sumHashes(copy)
	for (const revision of status.applied) {
		const name = fileOf(copy, revision.version)
		if (!hashes.has(name) || hashes.get(name) === revision.hash) continue
		throw new Error(
			`${name} was applied, then edited: its hash is not the one Atlas recorded; restore the file, or put the change in a new one`,
		)
	}
}

function checkHistory(status: AtlasStatus, copy: string): string | undefined {
	const partial = status.applied.find((revision) => revision.applied < revision.total && revision.error !== "")
	if (partial === undefined) {
		if (status.error !== "") throw new Error(`atlas migrate status: ${explainAtlasFailure(status.error)}`)
		/* Atlas lists a file older than the latest applied one as neither pending nor an error */
		const recorded = new Set(status.applied.map((revision) => revision.version))
		const current = /^\d+$/.test(status.current) ? status.current : undefined
		const late = status.available.find(
			(file) => current !== undefined && !recorded.has(file.Version) && file.Version < current,
		)
		if (late !== undefined) throw new Error(explainAtlasFailure(`migration file ${late.Name} was added out of order`))
		refuseEdited(status, copy)
		return undefined
	}
	const name = fileOf(copy, partial.version)
	const where = `${name} ran ${partial.applied} of its ${partial.total} statements before it failed at ${partial.errorStmt} (${partial.error})`
	if (sumHashes(copy).get(name) !== partial.hash) {
		throw new Error(
			`${where}, outside a transaction, and has changed since; restore it, or fix the database by hand and run comb migrate baseline`,
		)
	}
	return where
}

/** `read()`, a file `name` Atlas cannot split refused by name */
function named<T>(name: string, read: () => T): T {
	try {
		return read()
	} catch (error) {
		throw new Error(`comb could not read ${name}: ${(error as Error).message}`, { cause: error })
	}
}

/**
 * Each pending file read from the snapshot, classified as Postgres against the schema the files
 * before it leave, names keyed under the target's schema, approved, its lock warnings shown
 */
async function approvePending(options: ApplyOptions, copy: string, pending: readonly AtlasFile[]): Promise<void> {
	/* Postgres statements are read from Postgres's parser, loaded once */
	await loadPostgresParser()
	const waiting = new Set(pending.map((file) => file.Name))
	/* names are keyed as Postgres resolves them under the URL's search_path, the target's schema (M72) */
	const scope = { schema: options.target.schema }
	const readAs = { dialect: "postgres" as const, ...scope }
	let schema = extractSchema("", undefined, readAs)
	/* a file before a pending one that Postgres's parser cannot read leaves its facts unknown (M75) */
	let unread: string | undefined
	for (const Name of sqlFiles(copy)) {
		const sql = readFileSync(join(copy, Name), "utf8")
		if (waiting.has(Name) && unread !== undefined) throw new Error(unread)
		const before = schema
		schema = named(Name, () => extractSchema(sql, before, readAs))
		/* the file's read, recorded beside the schema it left: no second parse */
		const unreadable = fileUnreadable(schema)
		unread ??=
			unreadable && `comb could not read ${Name}: ${JSON.stringify(unreadable.statement)} (${unreadable.error})`
		if (!waiting.has(Name)) continue
		const migration = parseMigration(sql, Name, { before, dialect: "postgres", ...scope })
		for (const warning of migration.classification.lockWarnings) options.print(`Lock warning in ${Name}: ${warning}`)
		const approval = await options.approve(migration)
		if (!approval.ok) throw new Refused(approval.message, [...waiting])
		if (approval.approvedBy !== undefined) options.print(`Approved in ${Name}: ${approval.approvedBy}`)
	}
}

type ApplyReport = { applied: Array<{ Error?: { Stmt: string; Text: string }; Name: string }>; error: string }

/** The apply's result: the files it applied, or the file and statement that failed */
function applied(ran: RunResult): string[] {
	if (ran.stdout.trim() === "") throw new Error(`atlas migrate apply: ${ran.stderr}`)
	const report = json<ApplyReport>(ran.stdout, "apply")
	const failed = report.applied.find((file) => file.Error !== undefined)
	if (failed?.Error !== undefined) {
		throw new Error(
			`${failed.Name} failed at ${failed.Error.Stmt}: ${failed.Error.Text}. It was rolled back; the files before it stay applied`,
		)
	}
	if (ran.code !== 0 || report.error !== "")
		throw new Error(`atlas migrate apply: ${explainAtlasFailure(report.error || ran.stderr)}`)
	return report.applied.map((file) => file.Name)
}

/** Apply the pending migrations of `options.dir` through Atlas; returns the files applied, or only checked */
async function applyWithAtlas(options: ApplyOptions): Promise<string[]> {
	const copy = snapshotDir(options.exec ?? run, options.dir)
	try {
		const status = atlasStatus(options, copy)
		const halfway = checkHistory(status, copy)
		if (halfway !== undefined) options.print(`${halfway}; resuming after them`)
		if (status.pending.length === 0) {
			options.print("No migrations to apply")
			return []
		}
		/* Atlas's dry run creates its revisions schema on a database with none, so a check of a
		   database with nothing applied inspects it instead, refusing what the dry run would: a check writes nothing */
		if (options.checkOnly === true && status.applied.length === 0)
			refuseUnclean({ exec: options.exec ?? run, target: options.target })
		else {
			const dry = atlas(options, copy, ["apply", "--dry-run", "--format", APPLY_FORMAT])
			if (dry.code !== 0) throw new Error(dry.stderr)
		}
		await approvePending(options, copy, status.pending)
		if (options.checkOnly === true) return status.pending.map((file) => file.Name)
		const files = applied(atlas(options, copy, ["apply", "--format", APPLY_FORMAT]))
		for (const name of files) options.print(`Apply: ${name}`)
		return files
	} finally {
		rmSync(copy, { force: true, recursive: true })
	}
}

/** `body` on a snapshot of the directory, removed afterwards */
function onSnapshot<T>(options: AtlasCommand, body: (copy: string) => T): T {
	const copy = snapshotDir(options.exec ?? run, options.dir)
	try {
		return body(copy)
	} finally {
		rmSync(copy, { force: true, recursive: true })
	}
}

const migrations = (n: number) => `${n} migration${n === 1 ? "" : "s"}`

/**
 * Record every migration of the directory as applied without running any (`atlas migrate set` to
 * the latest file's version), for a database whose schema was set up some other way. Refused when
 * the database already records migrations, and when its tables are not the ones the migrations
 * leave. Returns the files marked.
 */
function baselineWithAtlas(options: AtlasCommand): string[] {
	return onSnapshot(options, (copy) => {
		const status = atlasStatus(options, copy, true)
		if (status.applied.length > 0) {
			throw new Error(
				`the database already records ${migrations(status.applied.length)} (up to ${status.current}); baseline marks a database that has none`,
			)
		}
		const files = sqlFiles(copy)
		const latest = files.at(-1)?.split("_")[0]
		if (latest === undefined) throw new Error("there are no migrations to record")
		refuseDrift({ exec: options.exec ?? run, target: options.target }, copy)
		const set = atlas(options, copy, ["set", latest])
		if (set.code !== 0) throw new Error(`atlas migrate set: ${set.stderr}`)
		for (const name of files) options.print(`Marked applied: ${name}`)
		return files
	})
}

/** Print what Atlas records as applied, what is pending, and where a file stopped halfway; returns both, by file name */
function statusWithAtlas(options: AtlasCommand): { applied: string[]; pending: string[] } {
	return onSnapshot(options, (copy) => {
		const status = atlasStatus(options, copy)
		const halfway = checkHistory(status, copy)
		options.print(`Applied: ${status.applied.length}${status.applied.length > 0 ? ` (up to ${status.current})` : ""}`)
		options.print(`Pending: ${status.pending.map((file) => file.Name).join(", ") || "none"}`)
		if (halfway !== undefined) options.print(`${halfway}; migrate apply resumes after them`)
		return {
			applied: status.applied.map((revision) => fileOf(copy, revision.version)),
			pending: status.pending.map((file) => file.Name),
		}
	})
}

export {
	type AtlasCommand,
	type ApplyOptions,
	applyWithAtlas,
	atlasStatus,
	type AtlasStatus,
	baselineWithAtlas,
	statusWithAtlas,
}
