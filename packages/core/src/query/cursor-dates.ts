/**
 * The Date a cursor's row read for each key whose value the keyset binds is another, as the cursor's
 * `d` carries it: epoch milliseconds, or "invalid" for an Invalid Date (cursor.ts)
 */

/* the Date of a row that holds none, as a cursor's `d` writes it */
const INVALID_READ = "invalid"

/** Each key's Date as its row read it from the wire, null a key whose value is it; none for a cursor that carries none */
function readOf(d: unknown, count: number): Array<Date | null> | null | undefined {
	if (d === undefined) return undefined
	if (!Array.isArray(d) || d.length !== count) return null
	const read = d.map((time: unknown) => {
		if (time === null) return null
		if (time === INVALID_READ) return new Date(Number.NaN)
		return typeof time === "number" ? new Date(time) : undefined
	})
	return read.includes(undefined) ? null : (read as Array<Date | null>)
}

/** The Date `read` as a cursor's `d` writes it where the cursor binds another value, else null */
function readTime(read: unknown, bound: unknown): number | typeof INVALID_READ | null {
	if (!(read instanceof Date) || read === bound) return null
	return Number.isNaN(read.getTime()) ? INVALID_READ : read.getTime()
}

export { readOf, readTime }
