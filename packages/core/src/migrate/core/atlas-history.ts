/**
 * The Postgres history Atlas reports, checked against the snapshot comb hands it (M76): Atlas
 * maps a revision to its file by version, the name up to the first `_` or `.sql`, and hashes each
 * file over its name and the files before it. So an applied file renamed under its version, gone,
 * or edited is named for what happened to it, checked in that order, before Atlas runs anything.
 */
import { sqlFiles, sumHashes } from "./atlas-dir.ts"
import { explainAtlasFailure } from "./atlas-target.ts"

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

/** Each applied revision whose file is gone or renamed to another version (M76), named by its version */
const goneFiles = (status: AtlasStatus, copy: string): string[] =>
	status.applied
		.filter((revision) => fileOf(copy, revision.version) === revision.version)
		.map((revision) => `${revision.version} was applied, and its file is gone or renamed`)

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

/**
 * The history checked against the snapshot. A history Atlas reports no error for may proceed. So
 * may a file Atlas ran halfway outside a transaction, if it is unchanged: Atlas resumes it by
 * statement count, so an edit would shift which statements it skips. Returns where that file
 * stopped, if one did. A renamed, gone or edited applied file is refused, in that order, since
 * Atlas's hashes are cumulative; a gone file is only named when `gone` takes it, as status does,
 * and then no hash is compared, as every one after it reads as changed.
 */
function checkHistory(status: AtlasStatus, copy: string, gone?: (line: string) => void): string | undefined {
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
		refuseRenamed(status, copy)
		const missing = goneFiles(status, copy)
		if (missing.length > 0 && gone === undefined) throw new Error(missing.join("; "))
		for (const line of missing) gone?.(line)
		if (missing.length === 0) refuseEdited(status, copy)
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

export { type AtlasFile, type AtlasRevision, type AtlasStatus, checkHistory, fileOf, versionOf }
