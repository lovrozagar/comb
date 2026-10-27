/**
 * `comb migrate apply` on Postgres: Atlas applies, comb decides what may run. Everything reads a
 * private snapshot of the migrations directory (atlas-dir.ts), so Atlas executes exactly the bytes
 * comb classified. In order: Atlas's status, which must report no error except a file it ran
 * halfway outside a transaction; a dry run, so a database that needs a baseline fails before anyone
 * is asked (a check of a database with no history inspects it instead, atlas-clean.ts); each pending file classified and approved (approval.ts); then the apply. comb passes no
 * flag that would skip a check (--allow-dirty, --tx-mode, --baseline) and no amount. The one
 * --exec-order it passes, non-linear, goes only to public's dry run and apply while public's
 * history holds another schema's 0.12 row (atlas-foreign.ts, M78): Atlas would count that row as
 * public's position, and checkHistory's late check over public's own revisions replaces Atlas's.
 */
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { ParsedMigration } from "../types.ts"
import type { Approval } from "./approval.ts"
import { snapshotDir, sqlFiles } from "./atlas-dir.ts"
import { adopted, adopts, sharedPrefix } from "./atlas-adopt.ts"
import { execOrder, type Foreign, foreignRows, ignoredLines, ownHistory } from "./atlas-foreign.ts"
import { type AtlasFile, type AtlasStatus, checkHistory, fileOf, filesOf, versionOf } from "./atlas-history.ts"
import { refuseUnclean } from "./atlas-clean.ts"
import { explainAtlasFailure, NOT_CLEAN, SHARED_REVISIONS } from "./atlas-target.ts"
import { atlas, type AtlasCommand, atlasStatus, json, NO_HISTORY, type Ran, scrubbing } from "./atlas-status.ts"
import { refuseDrift } from "./baseline-compare.ts"
import { extractSchema, parseRead } from "./parse.ts"
import { run } from "./process.ts"
import { Refused } from "./refused.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { pgRead } from "./pg-split.ts"
import { schemaOfRead } from "./schema.ts"

const APPLY_FORMAT = '{"target":{{ json .Target }},"applied":{{ json .Applied }},"error":{{ json .Error }}}'

type ApplyOptions = AtlasCommand & {
	/** whether a classified migration may run: approval.ts's rule, asking a person when it must */
	approve(migration: ParsedMigration): Promise<Approval>
	/** only check: stop once every pending file is approved, applying nothing */
	checkOnly?: boolean | undefined
}

/** The files 0.12's shared history ran, while `own`, the schema's own history, records none (M77) */
function sharedRan(options: AtlasCommand, copy: string, own: AtlasStatus): string[] {
	if (options.target.schema === "public" || own.applied.length > 0) return []
	return sharedPrefix(atlasStatus({ ...options, revisions: SHARED_REVISIONS }, copy, { notClean: true }), copy)
}

/** `own` as status, apply and check take it: a database with objects and no history, or one adoption gave, refused */
function known(own: AtlasStatus): AtlasStatus {
	if (own === NO_HISTORY) throw new Error(`atlas migrate status: ${NOT_CLEAN}`)
	return own
}

/** `raw` as the target's own history: another schema's rows in public's left out, each named (M78) */
function ownOf(options: AtlasCommand, copy: string, raw: AtlasStatus): { foreign: Foreign; status: AtlasStatus } {
	const foreign = foreignRows(options, copy, raw)
	for (const line of ignoredLines(foreign, options.target)) options.print(line)
	return { foreign, status: ownHistory(raw, foreign, copy) }
}

/** Record `ran` in the schema's own history, without running it: Atlas writes the rows in one transaction */
function adopt(options: AtlasCommand, copy: string, ran: readonly string[]): void {
	const set = atlas(options, copy, ["set", versionOf(ran.at(-1) as string).version])
	if (set.code !== 0) throw new Error(`atlas migrate set: ${set.said}`)
	options.print(adopted(ran))
}

/** The snapshot's files after `ran`, as Atlas lists a pending file */
const after = (copy: string, ran: readonly string[]): AtlasFile[] => filesOf(copy).slice(ran.length)

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
	const readAs = { dialect: "postgres" as const, schema: options.target.schema }
	let schema = extractSchema("", undefined, readAs)
	/* a file before a pending one that Postgres's parser cannot read leaves its facts unknown (M75) */
	let unread: string | undefined
	for (const Name of sqlFiles(copy)) {
		const sql = readFileSync(join(copy, Name), "utf8")
		if (waiting.has(Name) && unread !== undefined) throw new Error(unread)
		const before = schema
		/* the file's one parse, for the schema it leaves and, pending, its approval (M86) */
		const file = { dialect: "postgres" as const, read: named(Name, () => pgRead(sql)), sql }
		schema = schemaOfRead(file, readAs.schema, before)
		const { unreadable } = file.read
		unread ??=
			unreadable && `comb could not read ${Name}: ${JSON.stringify(unreadable.statement)} (${unreadable.error})`
		if (!waiting.has(Name)) continue
		const migration = parseRead({ ...file, filename: Name }, { before, schema: readAs.schema })
		for (const warning of migration.classification.lockWarnings) options.print(`Lock warning in ${Name}: ${warning}`)
		const approval = await options.approve(migration)
		if (!approval.ok) throw new Refused(approval.message, [...waiting])
		if (approval.approvedBy !== undefined) options.print(`Approved in ${Name}: ${approval.approvedBy}`)
	}
}

type ApplyReport = { applied: Array<{ Error?: { Stmt: string; Text: string }; Name: string }>; error: string }

/** The apply's result: the files it applied, or the file and statement that failed */
function applied(ran: Ran): string[] {
	if (ran.stdout.trim() === "") throw new Error(`atlas migrate apply: ${ran.said}`)
	const report = json<ApplyReport>(ran.stdout, "apply")
	const failed = report.applied.find((file) => file.Error !== undefined)
	if (failed?.Error !== undefined) {
		const { Stmt, Text } = failed.Error
		throw new Error(
			`${failed.Name} failed at ${ran.scrub(Stmt)}: ${ran.scrub(Text)}. It was rolled back; the files before it stay applied`,
		)
	}
	if (ran.code !== 0 || report.error !== "")
		throw new Error(
			`atlas migrate apply: ${report.error === "" ? ran.said : explainAtlasFailure(report.error, ran.scrub)}`,
		)
	return report.applied.map((file) => file.Name)
}

/** Apply the pending migrations of `options.dir` through Atlas; returns the files applied, or only checked */
async function applyWithAtlas(options: ApplyOptions): Promise<string[]> {
	const copy = snapshotDir(options.exec ?? run, options.dir)
	try {
		const own = atlasStatus(options, copy, { notClean: true })
		const ran = sharedRan(options, copy, own)
		/* a check of an adoption writes nothing: it classifies the files after what 0.12 ran */
		if (ran.length > 0 && options.checkOnly === true) {
			options.print(adopts(ran))
			await approvePending(options, copy, after(copy, ran))
			return after(copy, ran).map((file) => file.Name)
		}
		if (ran.length > 0) adopt(options, copy, ran)
		const { foreign, status } = ownOf(options, copy, ran.length > 0 ? atlasStatus(options, copy) : known(own))
		const halfway = checkHistory(status, copy, { scrub: scrubbing(options.target), unread: foreign.unread })
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
			const dry = atlas(options, copy, ["apply", "--dry-run", ...execOrder(foreign), "--format", APPLY_FORMAT])
			if (dry.code !== 0) throw new Error(dry.said)
		}
		await approvePending(options, copy, status.pending)
		if (options.checkOnly === true) return status.pending.map((file) => file.Name)
		const files = applied(atlas(options, copy, ["apply", ...execOrder(foreign), "--format", APPLY_FORMAT]))
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
		const status = atlasStatus(options, copy, { notClean: true })
		if (status.applied.length > 0) {
			throw new Error(
				`the database already records ${migrations(status.applied.length)} (up to ${status.current}); baseline marks a database that has none`,
			)
		}
		/* what 0.12 ran is recorded, and only that: the files after it still run on apply (M77) */
		const ran = sharedRan(options, copy, status)
		if (ran.length > 0) {
			adopt(options, copy, ran)
			return ran
		}
		const files = sqlFiles(copy)
		const latest = files.at(-1)?.split("_")[0]
		if (latest === undefined) throw new Error("there are no migrations to record")
		refuseDrift({ exec: options.exec ?? run, target: options.target }, copy)
		const set = atlas(options, copy, ["set", latest])
		if (set.code !== 0) throw new Error(`atlas migrate set: ${set.said}`)
		for (const name of files) options.print(`Marked applied: ${name}`)
		return files
	})
}

/** Print what Atlas records as applied, what is pending, and where a file stopped halfway; returns both, by file name */
function statusWithAtlas(options: AtlasCommand): { applied: string[]; pending: string[] } {
	return onSnapshot(options, (copy) => {
		const own = atlasStatus(options, copy, { notClean: true })
		const ran = sharedRan(options, copy, own)
		if (ran.length > 0) {
			const rest = after(copy, ran).map((file) => file.Name)
			options.print("Applied: 0")
			options.print(`Pending: ${rest.join(", ") || "none"}`)
			options.print(adopts(ran))
			return { applied: [], pending: rest }
		}
		const { foreign, status } = ownOf(options, copy, known(own))
		const missing: string[] = []
		const halfway = checkHistory(status, copy, {
			gone: (line) => missing.push(line),
			scrub: scrubbing(options.target),
			unread: foreign.unread,
		})
		options.print(`Applied: ${status.applied.length}${status.applied.length > 0 ? ` (up to ${status.current})` : ""}`)
		options.print(`Pending: ${status.pending.map((file) => file.Name).join(", ") || "none"}`)
		for (const line of missing) options.print(line)
		if (halfway !== undefined) options.print(`${halfway}; migrate apply resumes after them`)
		return {
			applied: status.applied.map((revision) => fileOf(copy, revision.version)),
			pending: status.pending.map((file) => file.Name),
		}
	})
}

export { type ApplyOptions, applyWithAtlas, baselineWithAtlas, statusWithAtlas }
