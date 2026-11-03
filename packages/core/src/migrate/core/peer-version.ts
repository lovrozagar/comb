/**
 * The version of a peer comb loads, and whether a range of comb's admits it (K2 of r21): npm's
 * semver for the forms comb's ranges take, without semver itself, which comb does not ship.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type Version = { pre: readonly string[]; tuple: readonly [number, number, number] }

/** `text` as a semver version, without its build; undefined when it is none */
function versionOf(text: string): Version | undefined {
	const [, major, minor, patch, pre] =
		/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text) ?? []
	if (major === undefined) return undefined
	return { pre: pre === undefined ? [] : pre.split("."), tuple: [Number(major), Number(minor), Number(patch)] }
}

/** One prerelease identifier against another, as semver orders them: numbers below words, each by its own order */
function comparePre(a: string, b: string): number {
	const [isA, isB] = [/^\d+$/.test(a), /^\d+$/.test(b)]
	if (isA && isB) return Number(a) - Number(b)
	if (isA !== isB) return isA ? -1 : 1
	return a < b ? -1 : a > b ? 1 : 0
}

/** `a` against `b` in semver's precedence */
function compare(a: Version, b: Version): number {
	for (const at of [0, 1, 2] as const) if (a.tuple[at] !== b.tuple[at]) return a.tuple[at] - b.tuple[at]
	/* a release is above its own prereleases */
	if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
	for (let at = 0; at < Math.min(a.pre.length, b.pre.length); at++) {
		const order = comparePre(a.pre[at] as string, b.pre[at] as string)
		if (order !== 0) return order
	}
	return a.pre.length - b.pre.length
}

type Comparator = { op: "<" | "<=" | "=" | ">" | ">="; version: Version }

/**
 * One comparator of a range, a caret one as the two it stands for. A `<` or `>=` bound short of a
 * patch (`<4`, `>=0.18`) is its missing parts at 0, and below their prereleases where it is `<`, as
 * npm reads `<4` as `<4.0.0-0`; npm reads any other short bound (`<=1`, `>1.2`, `^1`) as a
 * different version, so it is refused rather than misread
 */
function comparatorsOf(word: string): Comparator[] {
	const match = /^(<=|>=|<|>|=|\^)?(.+)$/.exec(word) as RegExpExecArray
	const op = match[1] ?? "="
	const text = match[2] as string
	const parts = (text.split("-", 1)[0] as string).split(".").length
	if (parts !== 3 && op !== "<" && op !== ">=") throw new TypeError(`comb reads no partial version in "${word}"`)
	const full = parts === 3 ? text : `${text}${".0".repeat(3 - parts)}${op === "<" ? "-0" : ""}`
	const version = versionOf(full) as Version
	if (op !== "^") return [{ op: op as Comparator["op"], version }]
	const [major, minor, patch] = version.tuple
	const next: Version["tuple"] = major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1]
	return [
		{ op: ">=", version },
		{ op: "<", version: { pre: ["0"], tuple: next } },
	]
}

// lookup-table: what each comparator admits of a version's order against its own
const ADMITS: Readonly<Record<Comparator["op"], (order: number) => boolean>> = {
	"<": (order) => order < 0,
	"<=": (order) => order <= 0,
	"=": (order) => order === 0,
	">": (order) => order > 0,
	">=": (order) => order >= 0,
}

/**
 * Whether `range` admits `version`, as npm's semver does for the forms comb's ranges take (`>=`,
 * `<`, an exact version, `^`, `||`): a prerelease only where a comparator of the same set names a
 * prerelease of its major, minor and patch.
 */
function admits(range: string, version: string): boolean {
	const at = versionOf(version)
	if (at === undefined) return false
	return range.split("||").some((set) => {
		const comparators = set.trim().split(/\s+/).flatMap(comparatorsOf)
		if (!comparators.every(({ op, version: bound }) => ADMITS[op](compare(at, bound)))) return false
		return (
			at.pre.length === 0 ||
			comparators.some(({ version: bound }) => bound.pre.length > 0 && bound.tuple.join() === at.tuple.join())
		)
	})
}

/** The version of `peer` whose file `entry` (a path or a file: URL) is: its package.json's, the first up from it that names it */
function installedVersion(peer: string, entry: string): string | undefined {
	let dir = dirname(entry.startsWith("file:") ? fileURLToPath(entry) : entry)
	for (;;) {
		const file = join(dir, "package.json")
		const manifest = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {}
		if (manifest["name"] === peer) return typeof manifest["version"] === "string" ? manifest["version"] : undefined
		const up = dirname(dir)
		if (up === dir) return undefined
		dir = up
	}
}

export { admits, installedVersion }
