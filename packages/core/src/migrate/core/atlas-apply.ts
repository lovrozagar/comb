/**
 * `comb migrate apply` on Postgres: Atlas applies, comb decides what may run. Everything reads a
 * private snapshot of the migrations directory (atlas-dir.ts), so Atlas executes exactly the bytes
 * comb classified. In order: Atlas's status, which must report no error except a file it ran
 * halfway outside a transaction; a dry run, so a database that needs a baseline fails before anyone
 * is asked (a check of a database with no history inspects it instead, atlas-clean.ts); each pending file classified and approved (approval.ts); then the apply. comb passes no
 * flag that would skip a check (--allow-dirty, --tx-mode, --baseline), and gives each file a call
 * of its own (atlas-apply-runs.ts), so no session setting of one file reaches the next.
 * The one
 * --exec-order it passes, non-linear, goes only to public's dry run and apply while public's
 * history holds another schema's 0.12 row (atlas-foreign.ts): Atlas would count that row as
 * public's position, and checkHistory's late check over public's own revisions replaces Atlas's.
 */
import type { ParsedMigration } from "../migration-types.ts"
import type { Approval } from "./approval.ts"
import { snapshotDir, sqlFiles } from "./atlas-dir.ts"
import { adopted, adopts, holdsNothing, proveAdoption, proven, sharedPrefix, theirs } from "./atlas-adopt.ts"
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
import { applyRuns } from "./atlas-apply-runs.ts"
import { NOT_CLEAN } from "./atlas-failure.ts"
import { SHARED_REVISIONS } from "./atlas-target.ts"
import { atlas, type AtlasCommand, atlasStatus, NO_HISTORY, scrubbing } from "./atlas-status.ts"
import { type ObjectsCompare, refuseHistoryDrift } from "./baseline-compare.ts"
import { run } from "./process.ts"
import { Refused } from "./refused.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { replayPending, throughPending } from "./pg-check-replay.ts"
import { sweepDev } from "./pg-replay-drops.ts"
import { readyDevSchema } from "./pg-dev-schema.ts"
import { readPending } from "./atlas-pending.ts"
import type { ReadHeld } from "./pg-schema-members.ts"

/** What Postgres's adoption reads beside Atlas: the catalog, the replay, the dev schema and whether the schema holds anything, comb's own unless a test says otherwise */
type Reads = Pick<ObjectsCompare, "readLive" | "readReplay" | "readyDev"> & { readHeld?: ReadHeld | undefined }

type ApplyOptions = AtlasCommand &
	Reads & {
		/** whether a classified migration may run: approval.ts's rule, asking a person when it must */
		approve(migration: ParsedMigration): Promise<Approval>
		/** only check: stop once every pending file is approved, applying nothing */
		checkOnly?: boolean | undefined
		/** how check replays the history and the pending files on dev: comb's own (pg-check-replay.ts) unless a test says otherwise */
		replayPending?: typeof replayPending | undefined
		sweepDev?: typeof sweepDev | undefined
	}

/**
 * The files 0.12's shared history ran, while `own`, the schema's own history, records none:
 * none when the schema holds nothing, whose matching rows are another schema's, said here
 */
async function sharedRan(options: AtlasCommand & Reads, copy: string, own: AtlasStatus): Promise<string[]> {
	if (options.target.schema === "public" || own.applied.length > 0) return []
	const prefix = sharedPrefix(
		await atlasStatus({ ...options, revisions: SHARED_REVISIONS }, copy, { notClean: true }),
		copy,
	)
	if (prefix.length === 0 || !(await holdsNothing(options))) return prefix
	options.print(theirs(options.target.schema, prefix))
	return []
}

/** `own` as status, apply and check take it: a database with objects and no history, or one adoption gave, refused */
function known(own: AtlasStatus): AtlasStatus {
	if (own === NO_HISTORY) throw new Error(`atlas migrate status: ${NOT_CLEAN}`)
	return own
}

/** `raw` as the target's own history: another schema's rows in public's left out, each named */
async function ownOf(
	options: AtlasCommand,
	copy: string,
	raw: AtlasStatus,
): Promise<{ foreign: Foreign; status: AtlasStatus }> {
	const foreign = await foreignRows(options, copy, raw)
	for (const line of ignoredLines(foreign, options.target)) options.print(line)
	return { foreign, status: ownHistory(raw, foreign, copy) }
}

/** Record `ran` in the schema's own history, without running it, once the schema proves it holds what they leave: Atlas writes the rows in one transaction */
async function adopt(options: AtlasCommand & Reads, copy: string, ran: readonly string[]): Promise<void> {
	await proveAdoption({ ...options, exec: options.exec ?? run }, copy, ran)
	const set = await atlas(options, copy, ["set", versionOf(ran.at(-1) as string).version])
	if (set.code !== 0) throw new Error(`atlas migrate set: ${set.said}`)
	options.print(adopted(ran))
}

/** The snapshot's files after `ran`, as Atlas lists a pending file */
const after = (copy: string, ran: readonly string[]): AtlasFile[] => filesOf(copy).slice(ran.length)

/**
 * Each pending file read and classified (readPending); on a check, then replayed on dev with the history
 * before it (pg-check-replay.ts) and classified again with what the replay read, or as apply
 * classifies it when the replay did not run; then each approved, its lock warnings shown
 */
async function approvePending(options: ApplyOptions, copy: string, pending: readonly AtlasFile[]): Promise<void> {
	/* Postgres statements are read from Postgres's parser, loaded once */
	await loadPostgresParser()
	const waiting = new Set(pending.map((file) => file.Name))
	const check = options.checkOnly === true
	/* what the file alone refuses goes before the replay, which never runs it; what the history decides waits for it */
	const classify = readPending(options, copy, waiting)
	let migrations = classify(check ? new Map() : undefined)
	/* a check lets Postgres decide what no database runs, before any file is approved */
	if (check) {
		const names = pending.map((file) => file.Name)
		const measured = await (options.replayPending ?? replayPending)(options, {
			files: throughPending(copy, names),
			pending: names,
		})
		migrations = classify(measured)
	}
	for (const migration of migrations) {
		const Name = migration.filename
		for (const warning of migration.classification.lockWarnings) options.print(`Lock warning in ${Name}: ${warning}`)
		const approval = await options.approve(migration)
		if (!approval.ok) throw new Refused(approval.message, { pending: [...waiting] })
		if (approval.approvedBy !== undefined) options.print(`Approved in ${Name}: ${approval.approvedBy}`)
		for (const caution of approval.cautions ?? []) options.print(`Cautious in ${Name}: ${caution}`)
	}
}

/** Apply the pending migrations of `options.dir` through Atlas; returns the files applied, or only checked */
async function applyWithAtlas(options: ApplyOptions): Promise<string[]> {
	const snapshot = await snapshotDir(options.exec ?? run, options.dir)
	const copy = snapshot.dir
	try {
		const own = await atlasStatus(options, copy, { notClean: true })
		const ran = await sharedRan(options, copy, own)
		/* a check of an adoption proves it as apply does, writes nothing, and classifies the files after what 0.12 ran */
		if (ran.length > 0 && options.checkOnly === true) {
			await proveAdoption({ ...options, exec: options.exec ?? run }, copy, ran)
			options.print(proven(ran))
			await approvePending(options, copy, after(copy, ran))
			return after(copy, ran).map((file) => file.Name)
		}
		if (ran.length > 0) await adopt(options, copy, ran)
		const { foreign, status } = await ownOf(
			options,
			copy,
			ran.length > 0 ? await atlasStatus(options, copy) : known(own),
		)
		const report = { elsewhere: foreign.elsewhere, scrub: scrubbing(options.target), unread: foreign.unread }
		const halfway = checkHistory(status, copy, report)
		if (halfway !== undefined) options.print(`${halfway}; resuming after them`)
		if (status.pending.length === 0) {
			options.print("No migrations to apply")
			return []
		}
		/* Atlas's dry run creates its revisions schema on a database with none, so a check of a
		   database with nothing applied inspects it instead, refusing what the dry run would: a check writes nothing */
		if (options.checkOnly === true && status.applied.length === 0)
			await refuseUnclean({ exec: options.exec ?? run, target: options.target })
		else {
			const dry = await atlas(options, copy, ["apply", "--dry-run", ...execOrder(foreign), "--format", APPLY_FORMAT])
			reported(dry, "apply --dry-run", copy)
		}
		await approvePending(options, copy, status.pending)
		if (options.checkOnly === true) return status.pending.map((file) => file.Name)
		/* a check killed past its cleanup left a role on devUrl's server, which a CREATE ROLE here would stop at */
		await (options.sweepDev ?? sweepDev)(options.target, options.print)
		return await applyRuns(options, copy, { foreign, report, status })
	} finally {
		snapshot.remove()
	}
}

/** `body`, which reads the database as it goes, on a snapshot of the directory, removed once it is done */
async function onSnapshot<T>(options: AtlasCommand, body: (copy: string) => Promise<T>): Promise<T> {
	const snapshot = await snapshotDir(options.exec ?? run, options.dir)
	const copy = snapshot.dir
	try {
		return await body(copy)
	} finally {
		snapshot.remove()
	}
}

/** The version of the last revision `status` records, which Atlas's current is not when it holds its placeholder */
const lastVersion = (status: AtlasStatus): string => (status.applied.at(-1) as AtlasRevision).version

const migrations = (n: number) => `${n} migration${n === 1 ? "" : "s"}`

/**
 * Record every migration of the directory as applied without running any (`atlas migrate set` to
 * the latest file's version), for a database whose schema was set up some other way. Refused when
 * the database already records migrations, and when its tables, functions or triggers are not the
 * ones the migrations leave. Returns the files marked.
 */
async function baselineWithAtlas(options: AtlasCommand & Reads): Promise<string[]> {
	return onSnapshot(options, async (copy) => {
		const status = await atlasStatus(options, copy, { notClean: true })
		if (status.applied.length > 0) {
			throw new Error(
				`the database already records ${migrations(status.applied.length)} (up to ${lastVersion(status)}); baseline marks a database that has none`,
			)
		}
		/* what 0.12 ran is recorded, and only that: the files after it still run on apply */
		const ran = await sharedRan(options, copy, status)
		if (ran.length > 0) {
			await adopt(options, copy, ran)
			return ran
		}
		const files = sqlFiles(copy)
		const latest = files.at(-1)
		if (latest === undefined) throw new Error("there are no migrations to record")
		/* the replay runs on a dev database holding the schema */
		await (options.readyDev ?? readyDevSchema)(options.target)
		/* comb's replay, in a database of its own, dropped after it, and Atlas reading what it left */
		await refuseHistoryDrift(options, copy)
		/* the version as Atlas reads the name, the reader status and adoption use */
		const set = await atlas(options, copy, ["set", versionOf(latest).version])
		if (set.code !== 0) throw new Error(`atlas migrate set: ${set.said}`)
		for (const name of files) options.print(`Marked applied: ${name}`)
		return files
	})
}

/** Print what Atlas records as applied, what is pending, and where a file stopped halfway; returns both, by file name */
async function statusWithAtlas(
	options: AtlasCommand & Pick<Reads, "readHeld" | "readLive">,
): Promise<{ applied: string[]; pending: string[] }> {
	return onSnapshot(options, async (copy) => {
		const own = await atlasStatus(options, copy, { notClean: true })
		const ran = await sharedRan(options, copy, own)
		if (ran.length > 0) {
			const rest = after(copy, ran).map((file) => file.Name)
			options.print("Applied: 0")
			options.print(`Pending: ${rest.join(", ") || "none"}`)
			options.print(adopts(ran))
			return { applied: [], pending: rest }
		}
		const { foreign, status } = await ownOf(options, copy, known(own))
		/* Atlas's status skips the clean check its apply's dry run makes, so it is inspected here as a check does */
		if (status.applied.length === 0 && status.pending.length > 0)
			await refuseUnclean({ exec: options.exec ?? run, target: options.target })
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
