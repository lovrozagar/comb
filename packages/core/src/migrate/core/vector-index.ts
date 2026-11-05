/**
 * libsql's vector indexes: `CREATE INDEX i ON t (libsql_vector_idx(c))` makes, as it
 * runs, a shadow table `i_shadow`, its index `i_shadow_idx`, and, with the first, the table
 * `libsql_vector_meta_shadow`. Those three are libsql's, never a file's: a copy creates the index
 * and lets libsql make them, and a baseline compares the index alone, since no engine but libsql's
 * reads it.
 */
import { asciiFold } from "./sql-code.ts"

/* a call of libsql_vector_idx: what makes an index a vector index */
const VECTOR_CALL = /\blibsql_vector_idx\s*\(/i

/** The table libsql keeps each vector index's settings in, made with the first */
const VECTOR_META = "libsql_vector_meta_shadow"

/** Whether `sql`, an index's definition, makes a vector index */
const isVectorIndexSql = (sql: string): boolean => VECTOR_CALL.test(sql)

/** The objects, by folded name, libsql makes for the vector indexes `names`: none for none */
function vectorShadows(names: readonly string[]): Set<string> {
	const made = new Set(names.flatMap((name) => [`${name}_shadow`, `${name}_shadow_idx`].map(asciiFold)))
	if (names.length > 0) made.add(VECTOR_META)
	return made
}

/* an index statement, after its leading comments, and the name it acts on, past a schema: "q", `q`, [q] or bare */
const CREATE_INDEX =
	/^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s*\.\s*)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w$]+))/i
const DROP_INDEX =
	/^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(?:(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s*\.\s*)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w$]+))/i

/** The folded name a matched index statement acts on */
const nameOf = (match: RegExpExecArray): string => asciiFold((match[1] ?? match[2] ?? match[3] ?? match[4]) as string)

/**
 * Whether `stmt`, one statement of a history, makes a vector index or drops one an earlier
 * statement made, by its folded name in `made`, which it keeps up to date
 */
function vectorStatement(stmt: string, made: Set<string>): boolean {
	const created = CREATE_INDEX.exec(stmt)
	if (created !== null && isVectorIndexSql(stmt)) {
		made.add(nameOf(created))
		return true
	}
	const dropped = DROP_INDEX.exec(stmt)
	if (dropped === null || !made.has(nameOf(dropped))) return false
	made.delete(nameOf(dropped))
	return true
}

export { isVectorIndexSql, vectorShadows, vectorStatement }
