/**
 * Only an opening call reaches a cursor's values (Q7, R1). In src/query, the decode of a payload,
 * decodePayload, is exported by no module and called only by openCursor, on the bytes openSealed
 * returns. Every function that returns a decoded cursor goes through openCursor, and a cursor's
 * bytes are read in cursor-seal.ts alone.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSync } from "oxc-parser"
import { describe, expect, it } from "vitest"

const QUERY = join(import.meta.dirname, "../../src/query")

/** Every non-test module of src/query, by its path under it */
function modules(dir: string, prefix = ""): Array<[string, string]> {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
		const rel = `${prefix}${entry.name}`
		if (entry.isDirectory()) return entry.name === "__fixtures__" ? [] : modules(join(dir, entry.name), `${rel}/`)
		const ts = entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
		return ts ? [[rel, readFileSync(join(dir, entry.name), "utf8")]] : []
	})
}

/** Each top-level function of `source` with the text of its body and its declared return type */
function functions(path: string, source: string): Map<string, { body: string; returns: string }> {
	const out = new Map<string, { body: string; returns: string }>()
	for (const statement of parseSync(path, source).program.body) {
		if (statement.type !== "FunctionDeclaration" || statement.id === null) continue
		const { returnType } = statement
		out.set(statement.id.name, {
			body: source.slice(statement.body?.start ?? 0, statement.body?.end ?? 0),
			returns: returnType === null || returnType === undefined ? "" : source.slice(returnType.start, returnType.end),
		})
	}
	return out
}

/** The names a module's `export { … }` lists */
const exported = (source: string) =>
	[...source.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((match) =>
		(match[1] as string).split(",").map((name) =>
			name
				.replace(/^\s*type\s+/, "")
				.trim()
				.split(/\s+as\s+/)
				.at(-1),
		),
	)

const ALL = modules(QUERY)
const CURSOR = functions("cursor.ts", readFileSync(join(QUERY, "cursor.ts"), "utf8"))

describe("a cursor's values only through an opening call (Q7, R1)", () => {
	it("exports the unverified decode from no module", () => {
		for (const [path, source] of ALL) expect(exported(source), path).not.toContain("decodePayload")
	})

	it("calls the payload decode only from openCursor, on what openSealed opened", () => {
		const callers = [...CURSOR].filter(([, { body }]) => body.includes("decodePayload(")).map(([name]) => name)
		expect(callers).toEqual(["openCursor"])
		const opened = CURSOR.get("openCursor")?.body ?? ""
		expect(opened.indexOf("openSealed(")).toBeGreaterThan(-1)
		expect(opened.indexOf("openSealed(")).toBeLessThan(opened.indexOf("decodePayload("))
		expect(CURSOR.get("cursorProblem")?.returns).toBe(": string | null")
	})

	it("returns a decoded cursor only from functions that verify", () => {
		for (const [path, source] of ALL) {
			for (const [name, { body, returns }] of functions(path, source)) {
				/* the payload decode itself is held to its one caller above */
				if (!/\bDecodedCursor\b/.test(returns) || name === "decodePayload") continue
				const verifies = name === "openCursor" || body.includes("openCursor(") || body.includes("readCursor(")
				expect(verifies, `${path} ${name}`).toBe(true)
			}
		}
	})

	it("reads a cursor's bytes in cursor-seal.ts alone", () => {
		const readers = ALL.filter(([, source]) => /\bdecodeBase64Url\(|\batob\(/.test(source)).map(([path]) => path)
		expect(readers.sort()).toEqual(["base64url.ts", "cursor-seal.ts"])
	})
})
