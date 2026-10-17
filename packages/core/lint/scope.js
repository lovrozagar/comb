const SRC = "/packages/core/src/"

/** The path under `packages/core/src/` for a non-test source file, else null. */
export function srcPath(filename) {
	const file = String(filename).replaceAll("\\", "/")
	if (/\.test\.[cm]?[jt]sx?$/.test(file)) return null
	const index = file.lastIndexOf(SRC)
	return index === -1 ? null : file.slice(index + SRC.length)
}

/** The AST nodes directly under `node`. */
export function children(node) {
	const out = []
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue
		for (const child of Array.isArray(value) ? value : [value]) {
			if (typeof child === "object" && child !== null && typeof child.type === "string") out.push(child)
		}
	}
	return out
}
