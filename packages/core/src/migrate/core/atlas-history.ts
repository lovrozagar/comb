/**
 * The Postgres history Atlas reports, checked against the snapshot comb hands it: an applied file
 * edited since, or one Atlas ran halfway and that changed, is refused before Atlas runs anything.
 */
import { sqlFiles, sumHashes } from "./atlas-dir.ts"
import { explainAtlasFailure } from "./atlas-target.ts"

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

/** The file of `version` in the snapshot */
const fileOf = (copy: string, version: string): string =>
	sqlFiles(copy).find((name) => name.startsWith(`${version}_`)) ?? version

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
 * stopped, if one did.
 */
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

export { type AtlasFile, type AtlasRevision, type AtlasStatus, checkHistory, fileOf }
