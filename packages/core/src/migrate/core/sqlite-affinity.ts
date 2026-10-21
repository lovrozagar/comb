/**
 * What a SQLite table definition does to a value it stores: each column's type affinity (by the
 * rules of SQLite's "Datatypes" page, section 3.1), the ON CONFLICT resolutions that drop or
 * replace a row instead of failing, and STRICT. A rebuild whose new table changes any of these
 * can change or lose what its copy lands, even when it copies every column.
 */
import type { TableInfo } from "../types.ts"

/** A column type's affinity: INT anywhere is INTEGER; CHAR, CLOB or TEXT is TEXT; BLOB or none is BLOB; REAL, FLOA or DOUB is REAL; anything else NUMERIC */
function affinityOf(declaredType: string): string {
	const type = declaredType.toUpperCase()
	if (type.includes("INT")) return "INTEGER"
	if (/CHAR|CLOB|TEXT/.test(type)) return "TEXT"
	if (type.trim() === "" || type.includes("BLOB")) return "BLOB"
	if (/REAL|FLOA|DOUB/.test(type)) return "REAL"
	return "NUMERIC"
}

/* a column's declared type ends where its first constraint begins */
const CONSTRAINT_START =
	/(?:^|\s+)(?:CONSTRAINT|NOT|NULL|PRIMARY|UNIQUE|CHECK|DEFAULT|COLLATE|REFERENCES|GENERATED|AS)\b.*$/is

/** The affinity of a column definition (its text after the name) */
const definitionAffinity = (definition: string): string => affinityOf(definition.replace(CONSTRAINT_START, ""))

const RESOLUTION = /\bON CONFLICT (ROLLBACK|FAIL|IGNORE|REPLACE)\b/gi

/** The non-ABORT resolutions of one body part, named by its column or the key it declares */
function conflictsOf(part: string, column: string | undefined): string[] {
	const key = column ?? /\(([^)]*)\)/.exec(part)?.[1]?.replaceAll(/\s+/g, "") ?? part
	return [...part.matchAll(RESOLUTION)].map((match) => `${key}: ${(match[1] as string).toUpperCase()}`)
}

/** Whether a CREATE TABLE's code ends in STRICT, after its column list */
const isStrict = (code: string): boolean => /\)[^()]*\bSTRICT\b[^()]*$/i.test(code)

/** What a rebuild's new table does to `columns`, the ones it copies from the earlier one, or nothing */
function definitionDrift(earlier: TableInfo, next: TableInfo, columns: readonly string[]): string | undefined {
	const retyped = columns.find((column) => (earlier.affinity[column] ?? "BLOB") !== (next.affinity[column] ?? "BLOB"))
	if (retyped !== undefined)
		return `changes ${retyped}'s affinity from ${earlier.affinity[retyped] ?? "BLOB"} to ${next.affinity[retyped] ?? "BLOB"}, which can change its values`
	const added = next.conflicts.find((conflict) => !earlier.conflicts.includes(conflict))
	if (added !== undefined) return `adds ON CONFLICT ${added}, which can drop or replace rows as they are copied`
	if (next.strict && !earlier.strict) return "makes the table STRICT, which refuses a value of another type"
	return undefined
}

export { affinityOf, conflictsOf, definitionAffinity, definitionDrift, isStrict }
