/** Reading a consumer package.json's `exports` before a generator adds its subpaths. */
import fs from "node:fs"
import path from "node:path"
import { writeJsonAtomic } from "./fs.ts"

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

/**
 * The package.json in `dir` or the closest directory above it, up to `root` when given; null when
 * there is none. Codegen passes the project root, so it never rewrites a package above the project.
 */
export function findNearestPackageJson(dir: string, root?: string): string | null {
	const stop = root === undefined ? undefined : path.resolve(root)
	for (let current = path.resolve(dir); current !== path.dirname(current); current = path.dirname(current)) {
		const candidate = path.join(current, "package.json")
		if (fs.existsSync(candidate)) return candidate
		if (current === stop) return null
	}
	return null
}

/** Point one subpath export at `file`, moved to the end of the map so reruns write the same order. */
export function setPackageExport(packageJsonPath: string, subpath: string, file: string): void {
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>
	const exports = readExports(pkg)
	delete exports[subpath]
	exports[subpath] = `./${path.relative(path.dirname(packageJsonPath), file)}`
	pkg["exports"] = exports
	writeJsonAtomic(packageJsonPath, pkg)
}
