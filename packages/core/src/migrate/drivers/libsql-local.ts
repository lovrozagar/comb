/**
 * A private database on libsql's own engine (SL3 of r22): a libsql or Turso target's proof copy and
 * baseline's replay run on the SQLite its files apply on, with its grammar, its functions and its
 * vector indexes, not on the runtime's newer one, which runs syntax libsql refuses and refuses
 * libsql's own. libsql's Database is the one the @libsql/client comb resolves loads (libsql-file.ts).
 */
import { segments } from "../core/sql-scan.ts"
import { bound, libsqlDatabase } from "./libsql-file.ts"
import type { LocalDb } from "./local-db.ts"

/**
 * The first statement of `sql` as the engine reads it, from what `compiles` accepts: libsql compiles
 * the first statement of a string and drops the rest, and names no end. A ; in code ends a statement
 * everywhere but inside a trigger's body, where the text up to it does not compile, so the first
 * statement is the shortest text up to a ; in code that compiles; with none, `sql` is one statement.
 */
function firstCompiled(sql: string, compiles: (text: string) => boolean): string {
	let at = 0
	for (const segment of segments(sql, "sqlite")) {
		const ends = segment.kind === "code" ? segment.text.matchAll(/;/g) : []
		for (const end of ends) {
			const text = sql.slice(0, at + end.index + 1)
			if (compiles(text)) return text
		}
		at += segment.text.length
	}
	return sql
}

/** How a database file, or `:memory:`, opens on libsql's engine */
async function libsqlLocal(): Promise<(file: string) => LocalDb> {
	const Database = await libsqlDatabase()
	return (file) => {
		const db = new Database(file)
		const compiles = (text: string) => {
			try {
				db.prepare(text)
				return true
			} catch {
				// reason: text that ends inside a trigger's body is no statement; libsql refusing it is the answer asked for
				return false
			}
		}
		return {
			all: (sql, params = []) => {
				const statement = db.prepare(bound(sql, params))
				const rows = statement.all() as Array<Record<string, unknown>>
				/* libsql holds a statement `all` read active until it is collected, and an EXPLAIN of a write held
				   so refuses the COMMIT after it (.tmp/grunt/p21/areas/sqlite/sl3/stmt-probe.log); `get` steps it
				   once and resets it, which a read, all `all` is given, allows */
				statement.get()
				return rows
			},
			close: () => db.close(),
			exec: (sql) => db.exec(sql),
			firstStatement: (sql) => firstCompiled(sql, compiles),
			run: (sql, params = []) => db.exec(bound(sql, params)),
		}
	}
}

export { firstCompiled, libsqlLocal }
