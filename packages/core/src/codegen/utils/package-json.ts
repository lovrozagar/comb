/** Reading a consumer package.json's `exports` before a generator adds its subpaths. */

/** A subpath's target: a path, a condition map, or a fallback list. */
export type ExportTarget = unknown

/**
 * The `exports` field as a subpath map. Node accepts three forms: a single target (`"./x.ts"`),
 * a condition map for `.` (keys without a leading dot), and a subpath map. The first two are the
 * package's `.` export, which a generator adding subpaths must keep.
 */
export function readExports(pkg: Record<string, unknown>): Record<string, ExportTarget> {
	const exports = pkg["exports"]
	if (exports === undefined || exports === null) return {}
	if (typeof exports !== "object" || Array.isArray(exports)) return { ".": exports }
	const keys = Object.keys(exports)
	if (keys.length > 0 && keys.every((key) => !key.startsWith("."))) return { ".": exports }
	return { ...(exports as Record<string, ExportTarget>) }
}
