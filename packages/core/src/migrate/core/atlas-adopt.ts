/**
 * M77: a schema other than public that comb 0.12 migrated kept its history in the shared
 * atlas_schema_revisions, which comb no longer reads for it. While the schema's own history is
 * missing or empty, the shared rows that match the directory's files as a prefix (in order,
 * version and hash equal, none skipped) are the files that ran: apply and baseline record them in
 * the schema's own history, and check and status say so. A shared row that names no file here is
 * another schema's, and stays as it is (M78).
 */
import { sqlFiles, sumHashes } from "./atlas-dir.ts"
import { type AtlasStatus, versionOf } from "./atlas-history.ts"

/** The files of the snapshot `copy` that 0.12's `shared` history ran; refused when it ran them otherwise */
function sharedPrefix(shared: AtlasStatus, copy: string): string[] {
	const files = sqlFiles(copy)
	const named = new Map(files.map((name) => [versionOf(name).version, name]))
	const hashes = sumHashes(copy)
	const rows = shared.applied.filter((row) => named.has(row.version))
	for (const [i, row] of rows.entries()) {
		const name = named.get(row.version) as string
		const due = files[i] as string
		if (name !== due) {
			throw new Error(
				`0.12's shared history records ${name} but not ${due}, which comes before it, so comb cannot tell what ran; record it by hand`,
			)
		}
		if (row.applied < row.total || row.error !== "")
			throw new Error(`${name} ran halfway under 0.12; finish or revert it by hand`)
		if (hashes.get(name) !== row.hash) {
			throw new Error(
				`${name} is not the file 0.12 ran: its hash is not the one the shared history recorded; restore it, and apply adopts it`,
			)
		}
	}
	return files.slice(0, rows.length)
}

/** What status and check say of the files 0.12 ran */
const adopts = (ran: readonly string[]): string =>
	`${ran.length} file${ran.length === 1 ? "" : "s"} ran under 0.12's shared history; apply adopts them`

/** What apply and baseline say once they recorded them */
const adopted = (ran: readonly string[]): string => `Adopted from 0.12's shared history: ${ran.join(", ")}`

export { adopted, adopts, sharedPrefix }
