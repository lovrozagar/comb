/**
 * Which file each row of comb's SQLite history records (`__drizzle_migrations`). A row recorded
 * with a name matches the file of that name, and the file is edited when it no longer has the
 * row's hash. A row from before 0.11 has no name: it matches one file by hash, among the files no
 * named row holds, so two files of one text (an index dropped, then made again) are two files. A
 * row that matches no file was edited or renamed after it was applied; read over the whole
 * directory, comb refuses it. A file applied with --file from outside the directory is recorded by
 * its path from it (`../lone.sql`), and no file of the directory is expected to match it.
 */

/** A file of the directory, and the hashes its text has (migrationHashes: current and pre-0.5.0) */
type FileHashes = { hashes: readonly string[]; name: string }

/** One row of the history */
type HistoryRow = { hash: string; name: string | null }

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
}

/** Match `rows` to `files`; `whole` when `files` is the whole directory, so a row no file matches is an orphan */
function matchHistory(files: readonly FileHashes[], rows: readonly HistoryRow[], whole: boolean): Matched {
	const matched: Matched = { applied: new Set(), edited: [], named: [], orphans: [] }
	const byName = new Map(files.map((file) => [file.name, file]))
	const held = new Set(rows.flatMap((row) => (row.name === null ? [] : [row.name])))
	for (const row of rows.filter((each) => each.name !== null)) {
		const file = byName.get(row.name as string)
		if (file === undefined) {
			if (whole && !(row.name as string).startsWith("../")) matched.orphans.push(row)
		} else if (file.hashes.includes(row.hash)) matched.applied.add(file.name)
		else matched.edited.push(file.name)
	}
	for (const row of rows.filter((each) => each.name === null)) {
		const file = files.find(
			(each) => !held.has(each.name) && !matched.applied.has(each.name) && each.hashes.includes(row.hash),
		)
		if (file === undefined) {
			if (whole) matched.orphans.push(row)
			continue
		}
		matched.applied.add(file.name)
		matched.named.push({ hash: row.hash, name: file.name })
	}
	return matched
}

/** Why the orphans of a history refuse a check or an apply, naming each row by its name, or its hash's start */
function orphanMessage(orphans: readonly HistoryRow[], dir: string): string {
	const n = orphans.length
	const rows = orphans.map((row) => row.name ?? row.hash.slice(0, 12)).join(", ")
	return `${n} applied migration${n === 1 ? " matches" : "s match"} no file in ${dir} (${rows}): one was edited or renamed after it was applied; restore it, or record the change in a new file`
}

export { type FileHashes, type HistoryRow, type Matched, matchHistory, orphanMessage }
