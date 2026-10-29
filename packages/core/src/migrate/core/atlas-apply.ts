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
import { adopted, adopts, proveAdoption, sharedPrefix } from "./atlas-adopt.ts"
import { execOrder, type Foreign, foreignRows, ignoredLines, ownHistory } from "./atlas-foreign.ts"
import {
	type AtlasFile,
	type AtlasRevision,
	type AtlasStatus,
	checkHistory,
	fileOf,
	filesOf,
	versionOf,
} from "./atlas-history.ts"
import { refuseUnclean } from "./atlas-clean.ts"
import { APPLY_FORMAT, reported } from "./atlas-report.ts"
import { NOT_CLEAN } from "./atlas-failure.ts"
import { SHARED_REVISIONS } from "./atlas-target.ts"
import { atlas, type AtlasCommand, atlasStatus, NO_HISTORY, scrubbing } from "./atlas-status.ts"
import { type ObjectsCompare, refuseDrift, refuseObjectDrift } from "./baseline-compare.ts"
import { extractSchema, parseRead } from "./parse.ts"
import { run } from "./process.ts"
import { Refused } from "./refused.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { readyDevSchema } from "./pg-dev-schema.ts"
import { pgRead } from "./pg-split.ts"
import { schemaOfRead } from "./schema.ts"

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

/** Record `ran` in the schema's own history, without running it, once the schema proves it holds what they leave: Atlas writes the rows in one transaction */
async function adopt(
	options: AtlasCommand & Pick<ObjectsCompare, "readLive" | "readyDev">,
	copy: string,
	ran: readonly string[],
): Promise<void> {
	await proveAdoption({ ...options, exec: options.exec ?? run }, copy, ran)
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

/** After an apply that ran no file and said nothing: done once another apply ran them, refused while any is pending (P8) */
function ranNothing(options: AtlasCommand, copy: string, foreign: Foreign): string[] {
	const { pending } = ownHistory(atlasStatus(options, copy), foreign, copy)
	if (pending.length > 0) {
		const names = pending.map((file) => file.Name).join(", ")
		throw new Error(`atlas migrate apply ran nothing and reported no error, yet still pending: ${names}`)
	}
	options.print("No migrations to apply")
	return []
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
		if (ran.length > 0) await adopt(options, copy, ran)
		const { foreign, status } = ownOf(options, copy, ran.length > 0 ? atlasStatus(options, copy) : known(own))
		const halfway = checkHistory(status, copy, {
			elsewhere: foreign.elsewhere,
			scrub: scrubbing(options.target),
			unread: foreign.unread,
		})
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
			reported(dry, "apply --dry-run", copy)
		}
		await approvePending(options, copy, status.pending)
		if (options.checkOnly === true) return status.pending.map((file) => file.Name)
		const files = reported(
			atlas(options, copy, ["apply", ...execOrder(foreign), "--format", APPLY_FORMAT]),
			"apply",
			copy,
		)
		if (files.length === 0) return ranNothing(options, copy, foreign)
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

/** `body`, which reads the database as it goes, on a snapshot of the directory, removed once it is done */
async function onSnapshotAsync<T>(options: AtlasCommand, body: (copy: string) => Promise<T>): Promise<T> {
	const copy = snapshotDir(options.exec ?? run, options.dir)
	try {
		return await body(copy)
	} finally {
		rmSync(copy, { force: true, recursive: true })
	}
}

/** The version of the last revision `status` records, which Atlas's current is not when it holds its placeholder (P20) */
const lastVersion = (status: AtlasStatus): string => (status.applied.at(-1) as AtlasRevision).version

const migrations = (n: number) => `${n} migration${n === 1 ? "" : "s"}`

/**
 * Record every migration of the directory as applied without running any (`atlas migrate set` to
 * the latest file's version), for a database whose schema was set up some other way. Refused when
 * the database already records migrations, and when its tables, functions or triggers are not the
 * ones the migrations leave. Returns the files marked.
 */
async function baselineWithAtlas(
	options: AtlasCommand & Pick<ObjectsCompare, "readLive" | "readyDev">,
): Promise<string[]> {
	return onSnapshotAsync(options, async (copy) => {
		const status = atlasStatus(options, copy, { notClean: true })
		if (status.applied.length > 0) {
			throw new Error(
				`the database already records ${migrations(status.applied.length)} (up to ${lastVersion(status)}); baseline marks a database that has none`,
			)
		}
		/* what 0.12 ran is recorded, and only that: the files after it still run on apply (M77) */
		const ran = sharedRan(options, copy, status)
		if (ran.length > 0) {
			await adopt(options, copy, ran)
			return ran
		}
		const files = sqlFiles(copy)
		const latest = files.at(-1)
		if (latest === undefined) throw new Error("there are no migrations to record")
		/* the replay runs on a dev database holding the schema (P12) */
		await (options.readyDev ?? readyDevSchema)(options.target)
		for (const notice of refuseDrift({ exec: options.exec ?? run, target: options.target }, copy))
			options.print(`Warning: Atlas: ${notice}`)
		await refuseObjectDrift(options, copy)
		/* the version as Atlas reads the name, the reader status and adoption use (M76, M88) */
		const set = atlas(options, copy, ["set", versionOf(latest).version])
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
		/* Atlas's status skips the clean check its apply's dry run makes, so it is inspected here as a check does (G1-a) */
		if (status.applied.length === 0 && status.pending.length > 0)
			refuseUnclean({ exec: options.exec ?? run, target: options.target })
		const missing: string[] = []
		const halfway = checkHistory(status, copy, {
			gone: (line) => missing.push(line),
			scrub: scrubbing(options.target),
			unread: foreign.unread,
			elsewhere: foreign.elsewhere,
		})
		options.print(
			`Applied: ${status.applied.length}${status.applied.length > 0 ? ` (up to ${lastVersion(status)})` : ""}`,
		)
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
