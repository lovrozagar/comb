/**
 * Which file each row of comb's SQLite history records (`__drizzle_migrations`). A row recorded
 * with a name matches the file of that name, and the file is edited when it no longer has the
 * row's hash. A row from before 0.11 has no name: it matches one file by hash, among the files no
 * named row holds, so two files of one text (an index dropped, then made again) are two files. A
 * row that matches no file was edited or renamed after it was applied; read over the whole
 * directory, comb refuses it. A file applied with --file from outside the directory is recorded by
 * its path from it (`../lone.sql`), and no file of the directory is expected to match it: a file
 * that has its text, a copy of it moved into the directory, is named, since it would run again
 * (M45). A file's
 * pre-0.5.0 hash matches only a row recorded before 0.5.0: a later row was recorded under the
 * current hash, so a match by the legacy one is an edit its normalizing hides (M44).
 */

/** A file of the directory, and the hashes its text has (migrationHashes: current first, then pre-0.5.0) */
type FileHashes = { hashes: readonly string[]; name: string }

/** One row of the history, with when it was recorded (`created_at`, ms) */
type HistoryRow = { createdAt: number; hash: string; name: string | null }

/** When v0.5.0, which changed the hash, was tagged (2026-10-18T00:56:29Z, ms): a row recorded before it may hold the legacy hash */
const V0_5_0 = 1792284989000

/** Whether `row` records `file`'s text: its current hash, or its legacy one on a row from before 0.5.0 */
const holds = (file: FileHashes, row: HistoryRow): boolean =>
	row.hash === file.hashes[0] || (row.createdAt < V0_5_0 && file.hashes.includes(row.hash))

/** What the history makes of the files */
type Matched = {
	/** the files a row records */
	applied: Set<string>
	/** the files recorded by name under a hash they no longer have */
	edited: string[]
	/** the unnamed rows matched by hash, each with the file it names */
	named: Array<{ hash: string; name: string }>
	/** the rows that match no file: edited or renamed since they were applied */
	orphans: HistoryRow[]
	/** the files not applied whose text a --file row (`../name`) holds */
	copies: Array<{ file: string; row: string }>
}

/** Match `rows` to `files`; `whole` when `files` is the whole directory, so a row no file matches is an orphan */
function matchHistory(files: readonly FileHashes[], rows: readonly HistoryRow[], whole: boolean): Matched {
	const matched: Matched = { applied: new Set(), copies: [], edited: [], named: [], orphans: [] }
	const byName = new Map(files.map((file) => [file.name, file]))
	const held = new Set(rows.flatMap((row) => (row.name === null ? [] : [row.name])))
	for (const row of rows.filter((each) => each.name !== null)) {
		const file = byName.get(row.name as string)
		if (file === undefined) {
			if (whole && !(row.name as string).startsWith("../")) matched.orphans.push(row)
		} else if (holds(file, row)) matched.applied.add(file.name)
		else matched.edited.push(file.name)
	}
	for (const row of rows.filter((each) => each.name === null)) {
		const file = files.find((each) => !held.has(each.name) && !matched.applied.has(each.name) && holds(each, row))
		if (file === undefined) {
			if (whole) matched.orphans.push(row)
			continue
		}
		matched.applied.add(file.name)
		matched.named.push({ hash: row.hash, name: file.name })
	}
	for (const row of rows.filter((each) => each.name?.startsWith("../") === true))
		for (const file of files.filter((each) => !matched.applied.has(each.name) && holds(each, row)))
			matched.copies.push({ file: file.name, row: row.name as string })
	return matched
}

/** A row of a history comb 0.12 left, by id */
type LegacyRow = HistoryRow & { id: number }

/**
 * The names comb 0.12's named rows take in 0.13, which a rebuild records once (M35). 0.12 named a
 * --file by its base name, wherever it was, so a name no file has is resolved in turn: a row whose
 * name a top-level file has keeps it; one whose hash exactly one file no other row holds has takes
 * that file's name (a file renamed under 0.12, so it is not applied again); any other is a file from
 * outside the directory, `../<name>`, as 0.13 names one. A file deleted under 0.12 reads so too:
 * 0.12 could not tell it either. A hash several such files hold names none of them, and is refused.
 */
function resolveLegacy(files: readonly FileHashes[], rows: readonly LegacyRow[]): Array<{ id: number; name: string }> {
	const byName = new Set(files.map((file) => file.name))
	const claimed = new Set(rows.flatMap((row) => (row.name !== null && byName.has(row.name) ? [row.name] : [])))
	const renamed: Array<{ id: number; name: string }> = []
	for (const row of rows) {
		if (row.name === null || byName.has(row.name)) continue
		const holders = files.filter((file) => !claimed.has(file.name) && holds(file, row))
		if (holders.length > 1)
			throw new Error(
				`${row.name}, applied before 0.13, holds the text of ${holders.map((file) => file.name).join(", ")}, none of them recorded: comb cannot tell which it was; rename all but one`,
			)
		const name = holders[0]?.name ?? `../${row.name}`
		if (holders[0] !== undefined) claimed.add(name)
		renamed.push({ id: row.id, name })
	}
	return renamed
}

/** Why the orphans of a history refuse a check or an apply, naming each row by its name, or its hash's start */
function orphanMessage(orphans: ReadonlyArray<Pick<HistoryRow, "hash" | "name">>, dir: string): string {
	const n = orphans.length
	const rows = orphans.map((row) => row.name ?? row.hash.slice(0, 12)).join(", ")
	return `${n} applied migration${n === 1 ? " matches" : "s match"} no file in ${dir} (${rows}): one was edited or renamed after it was applied; restore it, or record the change in a new file`
}

export { type FileHashes, type HistoryRow, type LegacyRow, type Matched, matchHistory, orphanMessage, resolveLegacy }
