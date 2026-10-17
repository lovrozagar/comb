/**
 * A faithful transcription of honey's schema-key search, so comb can prove its
 * stamps are findable by the consumer that actually reads them.
 *
 * Source of record: `@lovrozagar/honey` `packages/core/src/codegen.ts` at commit
 * cd7eb5c — `schemaChildren`, `searchSchemaKey`, `DEEP_SEARCH_MAX_DEPTH`.
 *
 * This is deliberately a copy rather than an import: comb does not depend on
 * honey, and the point of the test is that comb's *output* satisfies honey's
 * *documented* contract. If honey changes this algorithm, these tests should be
 * updated to match and will show exactly what comb has to do differently.
 */

type SchemaMetaHit =
	| { found: "ambiguous"; values: readonly unknown[] }
	| { found: false }
	| { found: true; value: unknown }

const DEEP_SEARCH_MAX_DEPTH = 6

/** Child schema nodes a deep search descends into, in visit order. */
function schemaChildren(node: Record<string, unknown>): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = []
	const push = (value: unknown): void => {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			out.push(value as Record<string, unknown>)
		}
	}
	const props = node["properties"]
	if (props !== null && typeof props === "object" && !Array.isArray(props)) {
		for (const child of Object.values(props as Record<string, unknown>)) push(child)
	}
	push(node["items"])
	for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
		const members = node[key]
		if (Array.isArray(members)) {
			for (const member of members) push(member)
		}
	}
	return out
}

/** Bounded BFS — shallowest match wins; several distinct values at that depth is ambiguous. */
function searchSchemaKey(
	root: Record<string, unknown>,
	key: string,
	maxDepth: number = DEEP_SEARCH_MAX_DEPTH,
): SchemaMetaHit {
	let level = [root]
	for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
		const matches: unknown[] = []
		const seen = new Set<string>()
		for (const node of level) {
			if (!Object.hasOwn(node, key) || node[key] === undefined) continue
			const fingerprint = JSON.stringify(node[key]) ?? "undefined"
			if (seen.has(fingerprint)) continue
			seen.add(fingerprint)
			matches.push(node[key])
		}
		if (matches.length === 1) return { found: true, value: matches[0] }
		if (matches.length > 1) return { found: "ambiguous", values: matches }
		const next: Record<string, unknown>[] = []
		for (const node of level) next.push(...schemaChildren(node))
		level = next
	}
	return { found: false }
}

/** `search: "root"` — the root, seeing through one level of `items` for a bare array output. */
function readRootKey(root: Record<string, unknown>, key: string): SchemaMetaHit {
	if (Object.hasOwn(root, key) && root[key] !== undefined) return { found: true, value: root[key] }
	const items = root["items"]
	if (items !== null && typeof items === "object" && !Array.isArray(items)) {
		const node = items as Record<string, unknown>
		if (Object.hasOwn(node, key) && node[key] !== undefined) return { found: true, value: node[key] }
	}
	return { found: false }
}

/** Depth at which a deep search first finds the key, or -1. Diagnostic only. */
function depthOfKey(root: Record<string, unknown>, key: string): number {
	let level = [root]
	for (let depth = 0; depth <= DEEP_SEARCH_MAX_DEPTH && level.length > 0; depth++) {
		if (level.some((n) => Object.hasOwn(n, key) && n[key] !== undefined)) return depth
		const next: Record<string, unknown>[] = []
		for (const node of level) next.push(...schemaChildren(node))
		level = next
	}
	return -1
}

export { DEEP_SEARCH_MAX_DEPTH, depthOfKey, readRootKey, type SchemaMetaHit, schemaChildren, searchSchemaKey }
