/* Sets of scalar values as sorted, disjoint inclusive ranges, read from the runtime's own Unicode tables */

/** A set of scalar values: sorted, disjoint, non-adjacent inclusive ranges */
export type CodeSet = ReadonlyArray<readonly [number, number]>

const LAST = 0x10ffff
const SURROGATES: readonly [number, number] = [0xd800, 0xdfff]

/* every scalar value in order, which a \p{…} run is read from; built once, on the first class */
// per-process-constant: the 1.1M scalar values as one string, built on first use
let scalars: string | undefined

// lru-cache: a General_Category's ranges, bounded by the 37 names a pattern may hold
const categories = /* @__PURE__ */ new Map<string, CodeSet>()

function everyScalar(): string {
	if (scalars === undefined) {
		const chunks: string[] = []
		for (let from = 0; from <= LAST; from += 0x1000) {
			const codes: number[] = []
			for (let code = from; code < from + 0x1000; code++)
				if (code < SURROGATES[0] || code > SURROGATES[1]) codes.push(code)
			chunks.push(String.fromCodePoint(...codes))
		}
		scalars = chunks.join("")
	}
	return scalars
}

/* the scalar value whose UTF-16 unit sits at `index` of everyScalar(): the surrogates are left out */
const codeAt = (index: number): number =>
	index < 0xd800 ? index : index < 0xf800 ? index + 0x800 : 0x10000 + ((index - 0xf800) >> 1)

/** `ranges`, possibly overlapping or touching, as one CodeSet; a range over the surrogates is cut around them */
export function union(ranges: Iterable<readonly [number, number]>): CodeSet {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0])
	const out: Array<[number, number]> = []
	for (const [lo, hi] of sorted) {
		const last = out.at(-1)
		if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi)
		else out.push([lo, hi])
	}
	return out.flatMap(([lo, hi]): Array<[number, number]> =>
		lo <= SURROGATES[1] && hi >= SURROGATES[0]
			? (
					[
						[lo, SURROGATES[0] - 1],
						[SURROGATES[1] + 1, hi],
					] as Array<[number, number]>
				).filter(([a, b]) => a <= b)
			: [[lo, hi]],
	)
}

/** The scalar values `set` leaves out */
export function complement(set: CodeSet): CodeSet {
	const out: Array<[number, number]> = []
	let next = 0
	for (const [lo, hi] of set) {
		if (lo > next) out.push([next, lo - 1])
		next = hi + 1
	}
	if (next <= LAST) out.push([next, LAST])
	return union(out)
}

/** The scalar values of the General_Category `name`, as the runtime's tables hold them */
export function categoryRanges(name: string): CodeSet {
	const known = categories.get(name)
	if (known !== undefined) return known
	const runs: Array<[number, number]> = []
	for (const run of everyScalar().matchAll(new RegExp(`\\p{${name}}+`, "gu")))
		runs.push([codeAt(run.index), codeAt(run.index + run[0].length - 1)])
	const set = union(runs)
	categories.set(name, set)
	return set
}

/** The UTF-8 bytes of `code` */
export const utf8Length = (code: number): number => (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4)

const LENGTHS: ReadonlyArray<readonly [number, number, number]> = [
	[0, 0x7f, 1],
	[0x80, 0x7ff, 2],
	[0x800, 0xffff, 3],
	[0x10000, LAST, 4],
]

/* the bytes of the UTF-8 sequences [lo, hi], all one length, splits into, as Rust's regex-syntax splits a range */
function sequenceBytes(lo: number, hi: number, bytes: number): number {
	for (let i = 1; i < bytes; i++) {
		const max = (1 << (6 * i)) - 1
		if ((lo & ~max) !== (hi & ~max)) {
			if ((lo & max) !== 0) return sequenceBytes(lo, lo | max, bytes) + sequenceBytes((lo | max) + 1, hi, bytes)
			if ((hi & max) !== max) return sequenceBytes(lo, (hi & ~max) - 1, bytes) + sequenceBytes(hi & ~max, hi, bytes)
		}
	}
	return bytes
}

/** The bytes of the UTF-8 byte-range sequences `set` compiles to in Rust's regex, the size a class costs there */
export function utf8Weight(set: CodeSet): number {
	let total = 0
	for (const [lo, hi] of set)
		for (const [from, to, bytes] of LENGTHS) {
			const [a, b] = [Math.max(lo, from), Math.min(hi, to)]
			if (a <= b) total += sequenceBytes(a, b, bytes)
		}
	return total
}
