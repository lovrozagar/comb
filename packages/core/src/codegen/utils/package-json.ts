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

/** A generated subpath (`./x`) under the database's namespace when it has one (`./<namespace>/x`) */
export const exportKey = (namespace: string | undefined, key: string): string =>
	namespace === undefined ? key : `./${namespace}/${key.slice(2)}`

/**
 * Whether `key` is a subpath this generator writes for its database, and so rewrites: one `own`
 * accepts, unnamespaced (a lone database's, or one left from before the package held two) or
 * under the database's namespace. Another database's namespace is never touched.
 */
export function ownsKey(namespace: string | undefined, key: string, own: (bare: string) => boolean): boolean {
	if (own(key)) return true
	const prefix = namespace === undefined ? undefined : `./${namespace}/`
	return prefix !== undefined && key.startsWith(prefix) && own(`./${key.slice(prefix.length)}`)
}

/**
 * Point one subpath export at `file`, under the database's namespace when it has one, moved to the
 * end of the map so reruns write the same order; the unnamespaced key goes too.
 */
export function setPackageExport(
	packageJsonPath: string,
	{ namespace, subpath }: { namespace?: string | undefined; subpath: string },
	file: string,
): void {
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>
	const exports = readExports(pkg)
	delete exports[subpath]
	subpath = exportKey(namespace, subpath)
	delete exports[subpath]
	exports[subpath] = `./${path.relative(path.dirname(packageJsonPath), file)}`
	pkg["exports"] = exports
	writeJsonAtomic(packageJsonPath, pkg)
}
