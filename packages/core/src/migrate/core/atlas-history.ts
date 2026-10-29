/**
 * The Postgres history Atlas reports, checked against the snapshot comb hands it (M76): Atlas
 * maps a revision to its file by version, the name up to the first `_` or `.sql`, and hashes each
 * file over its name and the files before it. So an applied file renamed under its version, gone,
 * or edited is named for what happened to it, checked in that order, before Atlas runs anything.
 */
import { sqlFiles, sumHashes } from "./atlas-dir.ts"
import { explainAtlasFailure } from "./atlas-failure.ts"

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

/** The file of `version` in the snapshot, as Atlas maps a revision to its file; the version when none is */
const fileOf = (copy: string, version: string): string =>
	sqlFiles(copy).find((name) => versionOf(name).version === version) ?? version

/**
 * Refuses an applied file renamed under its version (M76): Atlas hashes each file over its name and
 * those before it, so the rename would read as an edit of every file from it on
 */
function refuseRenamed(status: AtlasStatus, copy: string): void {
	for (const revision of status.applied) {
		const name = fileOf(copy, revision.version)
		if (name === revision.version || versionOf(name).description === revision.description) continue
		const was =
			revision.description === "" ? `${revision.version}.sql` : `${revision.version}_${revision.description}.sql`
		throw new Error(`${revision.version} was applied as ${was} and is now ${name}; restore its name`)
	}
}

/** Why a gone revision may be no gone file: another schema's history unread, or another schema there at all (G1-b) */
function goneWhy({ elsewhere, unread }: Pick<Report, "elsewhere" | "unread">): string {
	if (unread !== undefined) return `; another schema's history could not be read: ${unread}`
	return elsewhere === true
		? "; if it is another schema's row from comb 0.12, run apply on that schema first to adopt it"
		: ""
}

/** Each applied revision whose file is gone or renamed to another version (M76), named by its version */
const goneFiles = (status: AtlasStatus, copy: string, why: Pick<Report, "elsewhere" | "unread">): string[] =>
	status.applied
		.filter((revision) => fileOf(copy, revision.version) === revision.version)
		.map((revision) => `${revision.version} was applied, and its file is gone or renamed${goneWhy(why)}`)

/** How checkHistory reports: `scrub` for Atlas's text it prints, every decision read raw (M79); `gone` takes a gone file's line, as status does; `unread`, why another schema's history could not be read (M78) */
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

/** Refuses a file older than the last applied one that Atlas lists as neither pending nor an error */
function refuseLate(status: AtlasStatus, scrub: Report["scrub"]): void {
	const recorded = new Set(status.applied.map((revision) => revision.version))
	const last = status.applied.at(-1)?.version
	const late = status.available.find((file) => last !== undefined && !recorded.has(file.Version) && file.Version < last)
	if (late !== undefined)
		throw new Error(explainAtlasFailure(`migration file ${late.Name} was added out of order`, scrub))
}

/** Where `partial`, a file Atlas ran halfway, stopped; only Atlas's text is scrubbed, the statement and its error */
const stoppedAt = (partial: AtlasRevision, copy: string, scrub: Report["scrub"]): string =>
	`${fileOf(copy, partial.version)} ran ${partial.applied} of its ${partial.total} statements before it failed at ${scrub(partial.errorStmt)} (${scrub(partial.error)})`

/**
 * Where `partial`, a file Atlas ran halfway outside a transaction, stopped, refused when the file
 * changed since: Atlas resumes it by statement count, so an edit would shift which statements it
 * skips. Restored, it resumes at the statement that failed (P11)
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
 * and before the half-run file's own change, since Atlas's hashes are cumulative (P11); a gone file
 * is only named when `gone` takes it, as status does, and then no hash is compared, as every one
 * after it reads as changed.
 */
function checkHistory(
	status: AtlasStatus,
	copy: string,
	{ elsewhere, gone, scrub, unread }: Report,
): string | undefined {
	const partial = status.applied.find((revision) => revision.applied < revision.total && revision.error !== "")
	/* a renamed or gone file first: Atlas calls a file older than a gone one out of order, and the gone one is the cause */
	refuseRenamed(status, copy)
	const missing = goneFiles(status, copy, { elsewhere, unread })
	if (missing.length > 0 && gone === undefined) throw new Error(missing.join("; "))
	/* the half-run file's own error, which Atlas's status repeats, is no other error; any other is honored, an
	   out-of-order file's among them (27.6 of plan 15), and one past a gone file is the gone file's doing */
	if (status.error !== "" && status.error !== partial?.error)
		throw new Error(
			missing.length > 0 ? missing.join("; ") : `atlas migrate status: ${explainAtlasFailure(status.error, scrub)}`,
		)
	refuseLate(status, scrub)
	for (const line of missing) gone?.(line)
	if (missing.length === 0) refuseEdited(status, copy, partial)
	if (partial === undefined) return undefined
	return missing.length > 0 ? stoppedAt(partial, copy, scrub) : resumable(partial, copy, scrub)
}

export { type AtlasFile, type AtlasRevision, type AtlasStatus, checkHistory, fileOf, filesOf, versionOf }
