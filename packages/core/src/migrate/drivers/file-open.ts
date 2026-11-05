/**
 * How a SQLite file database a migrate command names opens, on bun:sqlite and libsql alike. A
 * read-only open, as check and status make, creates nothing, so a missing file is refused. A
 * writable open creates the file, so it creates the file's folder too. An open that fails names the
 * path it tried, which neither engine's own error does (`unable to open database file`).
 */
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseMissing } from "./missing.ts"

/** What `open` gives for the database at `file`: refused when missing and `readonly`, its folder made first when not; a failure, the folder's among them, names `file` and keeps the engine's string `code` */
export async function openFileDatabase<T>(file: string, readonly: boolean, open: () => T | Promise<T>): Promise<T> {
	if (readonly && !existsSync(file))
		throw new DatabaseMissing(`${file} does not exist; check and status open a database read-only, and create none`)
	try {
		if (!readonly) mkdirSync(dirname(file), { recursive: true })
		return await open()
	} catch (error) {
		const wrapped = new Error(`cannot open the SQLite database ${file}: ${(error as Error).message}`, { cause: error })
		/* the engine's code (a LibsqlError's SQLITE_CANTOPEN, a SqliteError's) stays readable where a caller reads it */
		const { code } = error as { code?: unknown }
		throw typeof code === "string" ? Object.assign(wrapped, { code }) : wrapped
	}
}
