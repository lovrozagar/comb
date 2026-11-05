/**
 * A plain SQLite column's write rule by its data type. SQLite's NUMERIC affinity
 * stores a text that reads as a number as an INTEGER or a REAL, which keeps 15 significant digits,
 * and a driver reads a number back as a JS number, so a `numeric()` write takes a value of at most
 * 15 digits, written as Postgres's numeric takes it: an exponent, a sign of +, blanks and a bare
 * point are spellings SQLite reads as a number, which the DTO would take as text.
 */
import type { FieldMeta } from "../../analyzer-types.ts"

/* the digits SQLite keeps of a REAL, and a JS number of an integer, exactly */
const KEPT_DIGITS = 15

/** A numeric's digits, at most as many as SQLite keeps, split anywhere about the point; a leading 0 or zeros cost none */
function numericRule(): string {
	const splits = [
		`[0-9]{1,${KEPT_DIGITS}}`,
		`0\\.[0-9]{1,${KEPT_DIGITS}}`,
		...Array.from({ length: KEPT_DIGITS - 1 }, (_, at) => `[0-9]{1,${KEPT_DIGITS - at - 1}}\\.[0-9]{${at + 1}}`),
	]
	return `z.string().regex(/^-?0*(?:${splits.join("|")})$/u, { message: "Must be a number of at most ${KEPT_DIGITS} digits, which SQLite's NUMERIC keeps as sent" })`
}

/** A plain SQLite numeric's write rule */
export const SQLITE_NUMERIC: string = /* @__PURE__ */ numericRule()

/** The write rule of a plain SQLite column of `field`'s data type; undefined when the plain type is its rule */
export const sqliteWriteRule = ({ dataType }: FieldMeta): string | undefined =>
	dataType === "string numeric" ? SQLITE_NUMERIC : undefined
