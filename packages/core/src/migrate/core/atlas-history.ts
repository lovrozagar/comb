/**
 * The Postgres history Atlas reports, checked against the snapshot comb hands it: Atlas
 * maps a revision to its file by version, the name up to the first `_` or `.sql`, and hashes each
 * file over its name and the files before it. So an applied file renamed under its version, gone,
 * or edited is named for what happened to it, checked in that order, before Atlas runs anything.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sqlFiles, sumHashes } from "./atlas-dir.ts"
import { explainAtlasFailure, failedStatement } from "./atlas-failure.ts"
import { outsideTransaction } from "./atlas-header.ts"

/** A migration file as Atlas lists it */
type AtlasFile = { Description: string; Name: string; Version: string }

/** A revision Atlas recorded: how many of the file's statements ran, and where it failed */
type AtlasRevision = {
	applied: number
	/** the name of the file it ran, after its version and `_` */
	description: string
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

/** A file name as Atlas reads it: the version up to the first `_` or `.sql`, the description after the `_` */
function versionOf(name: string): { description: string; version: string } {
	const [version = "", description = ""] = name.replace(/\.sql$/, "").split(/_(.*)/s)
	return { description, version }
}

/** The snapshot's files as Atlas lists one */
const filesOf = (copy: string): AtlasFile[] =>
	sqlFiles(copy).map((Name) => ({ Description: versionOf(Name).description, Name, Version: versionOf(Name).version }))

/** The name `revision` was applied as: its version, then `_` and its description when it has one */
const appliedAs = (revision: Pick<AtlasRevision, "description" | "version">): string =>
	revision.description === "" ? `${revision.version}.sql` : `${revision.version}_${revision.description}.sql`

/** The applied file that sorts last by name, as Atlas orders files; undefined while none is applied */
const lastApplied = (applied: readonly AtlasRevision[]): string | undefined =>
	applied
		.map(appliedAs)
		.reduce<string | undefined>((last, name) => (last === undefined || name > last ? name : last), undefined)

/** The file of `version` in the snapshot, as Atlas maps a revision to its file; the version when none is */
const fileOf = (copy: string, version: string): string =>
	sqlFiles(copy).find((name) => versionOf(name).version === version) ?? version

/**
 * Refuses an applied file renamed under its version: Atlas hashes each file over its name and
 * those before it, so the rename would read as an edit of every file from it on
 */
function refuseRenamed(status: AtlasStatus, copy: string): void {
	for (const revision of status.applied) {
		const name = fileOf(copy, revision.version)
		if (name === revision.version || versionOf(name).description === revision.description) continue
		throw new Error(`${revision.version} was applied as ${appliedAs(revision)} and is now ${name}; restore its name`)
	}
}

/** Why a gone revision may be no gone file: another schema's history unread, or another schema there at all */
function goneWhy({ elsewhere, unread }: Pick<Report, "elsewhere" | "unread">): string {
	if (unread !== undefined) return `; another schema's history could not be read: ${unread}`
	return elsewhere === true
		? "; if it is another schema's row from comb 0.12, run apply on that schema first to adopt it"
		: ""
}

/** Each applied revision whose file is gone or renamed to another version, named by its version */
const goneFiles = (status: AtlasStatus, copy: string, why: Pick<Report, "elsewhere" | "unread">): string[] =>
	status.applied
		.filter((revision) => fileOf(copy, revision.version) === revision.version)
		.map((revision) => `${revision.version} was applied, and its file is gone or renamed${goneWhy(why)}`)

/** How checkHistory reports: `scrub` for Atlas's text it prints, every decision read raw; `gone` takes a gone file's line, as status does; `unread`, why another schema's history could not be read */
type Report = {
	elsewhere?: boolean | undefined
	gone?: ((line: string) => void) | undefined
	scrub(text: string): string
	unread?: string | undefined
}

/**
 * Refuses an applied file edited since, as comb does on SQLite: Atlas never runs it again, so the
 * database does not hold what the file now says, and later files would be classified against it.
 * A file Atlas ran halfway, `partial`, is left to resumable.
 */
function refuseEdited(status: AtlasStatus, copy: string, partial: AtlasRevision | undefined): void {
	const hashes = sumHashes(copy)
	for (const revision of status.applied) {
		const name = fileOf(copy, revision.version)
		if (revision === partial || !hashes.has(name) || hashes.get(name) === revision.hash) continue
		throw new Error(
			`${name} was applied, then edited: its hash is not the one Atlas recorded; restore the file, or put the change in a new one`,
		)
	}
}

/**
 * Refuses a file never applied that sorts by name before the last applied one, as comb does on
 * SQLite: Atlas orders files by name and skips such a file without a word. One that sorts before a
 * gone file is that file's doing, so the gone files are named instead
 */
function refuseLate(status: AtlasStatus, missing: readonly string[], scrub: Report["scrub"]): void {
	const recorded = new Set(status.applied.map((revision) => revision.version))
	const last = lastApplied(status.applied)
	const late = status.available.find((file) => last !== undefined && !recorded.has(file.Version) && file.Name < last)
	if (late === undefined) return
	if (missing.length > 0) throw new Error(missing.join("; "))
	throw new Error(
		`${scrub(late.Name)} was never applied, yet it sorts before ${scrub(last as string)}, which was; rename it to sort after the applied files and run atlas migrate hash`,
	)
}

/** The highest version of `applied`, compared as text as Atlas compares them, with the name it was applied as */
const topOf = (applied: readonly AtlasRevision[]): { name: string; version: string } | undefined =>
	applied
		.map((revision) => ({ name: appliedAs(revision), version: revision.version }))
		.reduce<{ name: string; version: string } | undefined>(
			(top, each) => (top === undefined || each.version > top.version ? each : top),
			undefined,
		)

/**
 * Refuses a file Atlas would leave half-run for good: it resumes a file it ran halfway outside a
 * transaction only while that file's version, compared as text, is the highest it recorded, and
 * otherwise runs the next file in its place and reports nothing pending. So `partial` below another
 * applied version is refused, and so is a pending txmode none file whose version sorts below one
 * applied or run before it, which a failure halfway would leave so
 */
function refuseUnresumable(status: AtlasStatus, copy: string, partial: AtlasRevision | undefined): void {
	let top = topOf(status.applied.filter((revision) => revision !== partial))
	if (partial !== undefined && top !== undefined && partial.version < top.version)
		throw new Error(
			`${appliedAs(partial)} ran ${partial.applied} of its ${partial.total} statements outside a transaction, and Atlas will not resume it: it resumes such a file only while its version is the highest applied, and ${partial.version} sorts below ${top.name}'s; run its remaining statements by hand, then set its applied count to ${partial.total} and its error to '' in its row of Atlas's atlas_schema_revisions table`,
		)
	for (const file of status.pending) {
		const late = top !== undefined && file.Version !== partial?.version && file.Version < top.version
		if (late && outsideTransaction(readFileSync(join(copy, file.Name), "utf8")))
			throw new Error(
				`${file.Name} runs outside a transaction (atlas:txmode none), yet its version sorts below ${top?.name}'s, which runs before it, and Atlas resumes such a file only while its version is the highest applied, so a failure halfway would stay; rename it so its version sorts above ${top?.version} and run atlas migrate hash`,
			)
		if (top === undefined || file.Version > top.version) top = { name: file.Name, version: file.Version }
	}
}

/**
 * The file whose version `atlas migrate set` takes to record the snapshot's first `count` files by
 * name, at least one: Atlas records each file in name order until the first whose version, compared
 * as text, sorts above the one it is given, so the one of the highest version among them. `over` is
 * the file after them that it would record as well, its version sorting no higher
 */
function setTo(copy: string, count: number): { over: AtlasFile | undefined; top: AtlasFile } {
	const files = filesOf(copy)
	const top = files
		.slice(1, count)
		.reduce((max, file) => (file.Version > max.Version ? file : max), files[0] as AtlasFile)
	const next = files[count]
	return { over: next !== undefined && next.Version <= top.Version ? next : undefined, top }
}

/** Where `partial`, a file Atlas ran halfway, stopped; only Atlas's text is scrubbed, the statement and its error */
const stoppedAt = (partial: AtlasRevision, copy: string, scrub: Report["scrub"]): string =>
	`${fileOf(copy, partial.version)} ran ${partial.applied} of its ${partial.total} statements before it failed at ${failedStatement(scrub(partial.errorStmt))} (${scrub(partial.error)})`

/**
 * Where `partial`, a file Atlas ran halfway outside a transaction, stopped, refused when the file
 * changed since: Atlas resumes it by statement count, so an edit would shift which statements it
 * skips. Restored, it resumes at the statement that failed
 */
function resumable(partial: AtlasRevision, copy: string, scrub: Report["scrub"]): string {
	const name = fileOf(copy, partial.version)
	const where = stoppedAt(partial, copy, scrub)
	if (sumHashes(copy).get(name) !== partial.hash) {
		throw new Error(
			`${where}, outside a transaction, and has changed since; restore it: migrate apply resumes at the statement that failed, so fix what made it fail, in the database, first`,
		)
	}
	return where
}

/**
 * The history checked against the snapshot. A history Atlas reports no error for may proceed, and
 * so may a file Atlas ran halfway outside a transaction, if it is unchanged; returns where that
 * file stopped, if one did. A renamed, gone, late or edited applied file is refused, in that order
 * and before the half-run file's own change, since Atlas's hashes are cumulative, and then a
 * txmode none file Atlas would not resume (refuseUnresumable); a gone file
 * is only named when `gone` takes it, as status does, and then no hash is compared, as every one
 * after it reads as changed.
 */
function checkHistory(
	status: AtlasStatus,
	copy: string,
	{ elsewhere, gone, scrub, unread }: Report,
): string | undefined {
	const partial = status.applied.find((revision) => revision.applied < revision.total && revision.error !== "")
	/* a renamed or gone file first: a file named before a gone one is the gone one's doing */
	refuseRenamed(status, copy)
	const missing = goneFiles(status, copy, { elsewhere, unread })
	if (missing.length > 0 && gone === undefined) throw new Error(missing.join("; "))
	/* the half-run file's own error, which Atlas's status repeats, is no other error; any other is honored, and
	   one past a gone file is the gone file's doing */
	if (status.error !== "" && status.error !== partial?.error)
		throw new Error(
			missing.length > 0 ? missing.join("; ") : `atlas migrate status: ${explainAtlasFailure(status.error, scrub)}`,
		)
	refuseLate(status, missing, scrub)
	for (const line of missing) gone?.(line)
	if (missing.length > 0) return partial === undefined ? undefined : stoppedAt(partial, copy, scrub)
	refuseEdited(status, copy, partial)
	refuseUnresumable(status, copy, partial)
	return partial === undefined ? undefined : resumable(partial, copy, scrub)
}

export {
	type AtlasFile,
	type AtlasRevision,
	type AtlasStatus,
	checkHistory,
	fileOf,
	filesOf,
	lastApplied,
	setTo,
	versionOf,
}
