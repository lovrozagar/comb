/**
 * The proof's check that each piece of comb's split is one statement to SQLite (SL2 of r22), asked
 * of the scratch copy's own engine, which compiles the piece as the target's would.
 */
import type { LocalDb } from "../drivers/local-db.ts"
import { preview } from "./classify-file.ts"
import { codeOf } from "./sql-code.ts"

/**
 * Refuses `sql` when SQLite reads it as more than one statement (SL2 of r22): comb applies each
 * statement of its split on its own, and libsql's client runs only the first of a string, so the
 * rest would never run where it does. The first statement SQLite compiles ends at a ; in code only
 * when the piece goes on after it. comb splits where SQLite ends a statement, so only a defect in
 * the split reaches this, and it fails here, before any apply, on every provider alike
 */
export function refuseFolded(db: LocalDb, sql: string): void {
	const first = db.firstStatement(sql)
	if (!codeOf(first, "sqlite").trimEnd().endsWith(";")) return
	throw new Error(
		`${preview(sql)}: SQLite reads this as more than one statement, the first ending at "${preview(first)}", where comb applies one; comb split this file where SQLite does not end a statement, so report it with the file`,
	)
}
