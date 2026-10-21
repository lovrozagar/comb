/**
 * A column helper's constraint object, read from its text: `c.text("name", { min: 5, max: 254 })`
 * or `c.text<{ min: 5 }>("name")`. References to imported constants resolve through the values the
 * caller passes, so two codegen runs never share state.
 */
import { createRequire } from "node:module"
import path from "node:path"

/** `"identifier.PROPERTY"` → the string an imported constant holds, e.g. `patterns.E164_PHONE`. */
export type IdentifierValues = ReadonlyMap<string, string>

// lookup-table: the empty value map callers without imports pass
const NO_VALUES: IdentifierValues = /* @__PURE__ */ new Map()

/**
 * Build an identifier value map by requiring imported modules and extracting
 * their exported object properties. Resolves workspace package paths from `cwd`.
 */
export function buildIdentifierValueMap(importedIds: Map<string, string>, cwd: string): Map<string, string> {
	const map = new Map<string, string>()
	const _require = createRequire(`${path.resolve(cwd)}/`)

	for (const [identifier, modulePath] of importedIds) {
		try {
			const mod = _require(modulePath) as Record<string, unknown>
			const obj = mod[identifier]
			if (typeof obj !== "object" || obj === null) continue

			for (const [key, value] of Object.entries(obj)) {
				if (typeof value === "string") {
					map.set(`${identifier}.${key}`, value)
				}
			}
		} catch {
			// reason: a module the consumer's context cannot load has no values to offer; its references stay as written
		}
	}

	return map
}

/**
 * Extract constraint object from column function parameter or type argument
 * Parameter format: c.text("name", { min: 5, max: 254 })
 * Type arg format: c.text<{ min: 5, max: 254 }>("name")
 */
export function extractConstraints(raw: string, identifiers: IdentifierValues = NO_VALUES): Record<string, unknown> {
	/* c.enum's third argument is a state machine, not per-value constraints.
	   Reading it here would flatten `terminal` / `transitions` into this map. */
	if (/c\.enum\s*\(/.test(raw)) return {}

	/* Try parameter-based constraints first (new format) */
	const paramContent = objectArgument(raw)
	if (paramContent !== null) {
		return parseConstraintObject(paramContent, identifiers)
	}

	/* Fallback to type argument for backward compatibility */
	const typeContent = extractBalancedBraces(raw, /c\.\w+<\s*\{/)
	if (typeContent !== null) {
		return parseConstraintObject(typeContent, identifiers)
	}

	return {}
}

/* a slash opens a regex literal where a value starts: after `:`, `,`, `{` or nothing */
function opensRegex(text: string, at: number, from: number): boolean {
	let j = at - 1
	while (j >= from && /\s/.test(text[j] as string)) j--
	return j < from || ":,{".includes(text[j] as string)
}

/** The index just past the string or regex literal that opens at `at`. */
function skipLiteral(text: string, at: number): number {
	const close = text[at]
	let j = at + 1
	while (j < text.length && text[j] !== close) j += text[j] === "\\" ? 2 : 1
	return j + 1
}

/** Calls `visit` for each character outside string and regex literals, until it returns false. */
function scanCode(text: string, from: number, visit: (at: number, ch: string) => boolean | void): void {
	let i = from
	while (i < text.length) {
		const ch = text[i] as string
		if (ch === '"' || ch === "'" || (ch === "/" && opensRegex(text, i, from))) {
			i = skipLiteral(text, i)
			continue
		}
		if (visit(i, ch) === false) return
		i++
	}
}

/** The text between the brace `startPattern` ends on and its matching close, or null when unbalanced. */
function extractBalancedBraces(raw: string, startPattern: RegExp): string | null {
	const match = startPattern.exec(raw)
	if (!match) return null
	const start = match.index + match[0].length
	let depth = 1
	let end = -1
	scanCode(raw, start, (at, ch) => {
		depth += ch === "{" ? 1 : ch === "}" ? -1 : 0
		if (depth > 0) return true
		end = at
		return false
	})
	return end < 0 ? null : raw.substring(start, end)
}

/**
 * The body of the first top-level object literal among the column helper's own arguments: never
 * an object a later call takes, as in `c.json("m", schema).default({ … })`
 */
function objectArgument(raw: string): string | null {
	const call = /c\.\w+\(/.exec(raw)
	if (call === null) return null
	let depth = 0
	let open = -1
	let body: string | null = null
	scanCode(raw, call.index + call[0].length, (at, ch) => {
		if ("([{".includes(ch)) {
			if (depth === 0 && ch === "{" && open < 0) open = at
			depth++
		} else if (")]}".includes(ch)) {
			depth--
			if (depth === 0 && at > open && open >= 0) body = raw.substring(open + 1, at)
		}
		return depth >= 0 && body === null
	})
	return body
}

/** Parse constraint object literal string into record */
function parseConstraintObject(content: string, identifiers: IdentifierValues): Record<string, unknown> {
	const pairs = splitConstraintPairs(content)
	const result: Record<string, unknown> = {}

	for (const pair of pairs) {
		const colonIndex = pair.indexOf(":")
		if (colonIndex === -1) continue

		const key = pair.substring(0, colonIndex).trim()
		const value = pair.substring(colonIndex + 1).trim()

		/* Parse value based on type */
		if (value === "true") {
			result[key] = true
		} else if (value === "false") {
			result[key] = false
		} else if (/^-?\d[\d_]*(?:\.\d[\d_]*)?$/.test(value)) {
			/* a decimal literal as TS writes it: sign, separators, fraction */
			result[key] = Number(value.replaceAll("_", ""))
		} else if (value.startsWith('"') && value.endsWith('"')) {
			/* Un-escape TS string escapes so raw patterns like "\\d" become "\d" */
			result[key] = value.slice(1, -1).replace(/\\\\/g, "\\")
		} else if (value.startsWith("'") && value.endsWith("'")) {
			result[key] = value.slice(1, -1).replace(/\\\\/g, "\\")
		} else if (identifiers.has(value)) {
			result[key] = identifiers.get(value)
		} else {
			result[key] = value
		}
	}

	return result
}

/** Split constraint pairs on commas, respecting regex and string literals */
function splitConstraintPairs(content: string): string[] {
	const cuts: number[] = []
	scanCode(content, 0, (at, ch) => {
		if (ch === ",") cuts.push(at)
	})
	const bounds = [-1, ...cuts, content.length]
	return bounds
		.slice(1)
		.map((end, k) => content.slice((bounds[k] as number) + 1, end).trim())
		.filter((pair) => pair !== "")
}

/**
 * Extract length constraint from field definition
 * Prioritizes constraints.max, falls back to legacy formats
 */
export function extractLength(raw: string): number | null {
	/* Try max constraint (new format) */
	const constraints = extractConstraints(raw)
	if (typeof constraints["max"] === "number") {
		return constraints["max"]
	}

	/* Fallback: positional parameter c.text("name", 50) */
	const positionalMatch = raw.match(/c\.text\("[\w_]+",\s*(\d+)/)
	if (positionalMatch && positionalMatch[1] !== undefined) {
		return parseInt(positionalMatch[1], 10)
	}

	/* Fallback: object property { length: 50 } */
	const lengthMatch = raw.match(/length:\s*(\d+)/)
	if (lengthMatch && lengthMatch[1] !== undefined) {
		return parseInt(lengthMatch[1], 10)
	}

	return null
}
