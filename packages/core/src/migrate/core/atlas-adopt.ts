/**
 * M77: a schema other than public that comb 0.12 migrated kept its history in the shared
 * atlas_schema_revisions, which comb no longer reads for it. While the schema's own history is
 * missing or empty, the shared rows that match the directory's files as a prefix (in order,
 * version and hash equal, none skipped) are the files that ran: apply and baseline record them in
 * the schema's own history, and check and status say so. A shared row that names no file here is
 * another schema's, and stays as it is (M78). A matching prefix is no proof: public's own rows
 * live in that table too, so a schema beside it that shares its directory matches them by version
 * and hash alone. Apply and baseline adopt only once the schema holds what replaying the prefix
 * leaves, its tables and its functions and triggers (P2 of the 0.14.1 review).
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sqlFiles, sumHashes } from "./atlas-dir.ts"
import { type AtlasStatus, versionOf } from "./atlas-history.ts"
import type { PgTarget } from "./atlas-target.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { type ObjectsCompare, refuseDrift, refuseObjectDrift, ReplayFailed } from "./baseline-compare.ts"
import type { Run } from "./process.ts"

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

/** `compare()`, a replay Atlas could not run on the dev database refused by devUrl's name: proof needs one it can reach */
function replayed<T>(compare: () => T, schema: string, ran: readonly string[]): T {
	try {
		return compare()
	} catch (error) {
		if (!(error instanceof ReplayFailed)) throw error
		throw new Error(
			`adopting 0.12's shared history needs devUrl, an empty Postgres database Atlas can reach, to prove ${schema} holds what it ran (${ran.join(", ")}); Atlas could not use it: ${error.message}`,
			{ cause: error },
		)
	}
}

/** Refuse to adopt `ran`, the files of the snapshot `copy` 0.12's shared history ran, unless the schema holds what replaying them leaves */
async function proveAdoption(
	options: ObjectsCompare & { exec: Run; target: PgTarget },
	copy: string,
	ran: readonly string[],
): Promise<void> {
	/* the replay reads each file as the statements Postgres runs */
	await loadPostgresParser()
	const prefix = mkdtempSync(join(tmpdir(), "comb-adopt-"))
	try {
		for (const name of ran) copyFileSync(join(copy, name), join(prefix, name))
		const { schema } = options.target
		const refusal = `${schema} does not hold what 0.12's shared history ran (${ran.join(", ")}), so comb adopts none of it`
		for (const notice of replayed(() => refuseDrift(options, prefix, refusal), schema, ran))
			options.print(`Warning: Atlas: ${notice}`)
		await refuseObjectDrift(options, prefix, refusal)
	} finally {
		rmSync(prefix, { force: true, recursive: true })
	}
}

/** What status and check say of the files 0.12 ran, which they do not prove */
const adopts = (ran: readonly string[]): string =>
	`${ran.length} file${ran.length === 1 ? "" : "s"} ran under 0.12's shared history; apply would adopt them, pending proof that the schema holds what they leave`

/** What apply and baseline say once they recorded them */
const adopted = (ran: readonly string[]): string => `Adopted from 0.12's shared history: ${ran.join(", ")}`

export { adopted, adopts, proveAdoption, sharedPrefix }
