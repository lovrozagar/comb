/**
 * A mirror FTS table in the proof copy (M42 part 2): an external-content or contentless one, whose
 * rows are its content table's, so comparing them proves nothing. The copy builds its index from
 * the seeded content table ('rebuild'), or from rows of its own for a contentless one, and a file
 * is compared by the index's row count: `<t>_docsize`, a row per document, or `<t>_idx` where the
 * table keeps no docsize. A count that falls is an index the file emptied, whatever its command's
 * spelling.
 */
import type { MemoryDb } from "../drivers/memory.ts"
import { asciiFold } from "./sql-code.ts"

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/** An external-content or contentless FTS table: it mirrors another table */
const isMirror = (object: { sql: string }): boolean =>
	/^CREATE VIRTUAL TABLE\b/i.test(object.sql) && /\bcontent\s*=\s*'/i.test(object.sql)

/** The rows a contentless mirror is seeded with, each a document of its own */
const SEEDED = 3

/** Build each mirror's index in the copy; returns the mirrors it could not build, with why */
function seedMirrors(db: MemoryDb, mirrors: ReadonlyArray<{ name: string; sql: string }>): Array<[string, string]> {
	const failed: Array<[string, string]> = []
	for (const { name, sql } of mirrors) {
		try {
			if (/\bcontent\s*=\s*''/i.test(sql)) seedOwnRows(db, name)
			else db.exec(`INSERT INTO ${quote(name)}(${quote(name)}) VALUES ('rebuild')`)
		} catch (error) {
			// reason: an index the copy cannot build proves nothing, so its table is listed unproven with why
			failed.push([
				asciiFold(name),
				`comb could not build its full-text index in the copy: ${(error as Error).message}`,
			])
		}
	}
	return failed
}

/** Seed a contentless mirror with documents of its own, each column a text of its row's */
function seedOwnRows(db: MemoryDb, name: string): void {
	const columns = db.all(`PRAGMA main.table_info(${quote(name)})`).map((info) => quote(String(info["name"])))
	const marks = columns.map(() => "?").join(", ")
	for (let doc = 1; doc <= SEEDED; doc++)
		db.run(`INSERT INTO ${quote(name)} (rowid, ${columns.join(", ")}) VALUES (?, ${marks})`, [
			doc,
			...columns.map((_, at) => `seed ${doc} ${at}`),
		])
}

/** Each mirror's index rows in the copy, by table */
function mirrorRows(db: MemoryDb): Map<string, number> {
	const tables = db
		.all("SELECT name, sql FROM main.sqlite_master WHERE type = 'table'")
		.map((row) => ({ name: String(row["name"]), sql: String(row["sql"]) }))
	const names = new Set(tables.map(({ name }) => name))
	const out = new Map<string, number>()
	for (const { name, sql } of tables) {
		if (!isMirror({ sql })) continue
		const index = [`${name}_docsize`, `${name}_idx`].find((shadow) => names.has(shadow))
		if (index !== undefined)
			out.set(asciiFold(name), Number(db.all(`SELECT count(*) AS n FROM main.${quote(index)}`)[0]?.["n"]))
	}
	return out
}

/** What a file did to each mirror's index: unsafe where it holds fewer rows than before */
function mirrorFindings(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): string[] {
	return [...before].flatMap(([table, rows]) => {
		const now = after.get(table) ?? rows
		return now < rows ? [`loses ${rows - now} of the ${rows} rows of the full-text index of ${table}`] : []
	})
}

export { isMirror, mirrorFindings, mirrorRows, seedMirrors }
