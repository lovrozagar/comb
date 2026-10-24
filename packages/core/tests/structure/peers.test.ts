/**
 * What comb asks of a consumer's dependencies. Every package its sources import is a dependency or
 * a peer; zod is required, because every schema module builds on it; a peer only some entry points
 * need is optional; and every peer range stops before the next major, so an install never pairs
 * comb with a breaking release it was not tested against. A runtime dependency ships its types too.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "../..")
const require = createRequire(join(ROOT, "package.json"))
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
	dependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
}
const peers = pkg.peerDependencies ?? {}
const optional = new Set(
	Object.entries(pkg.peerDependenciesMeta ?? {})
		.filter(([, m]) => m.optional)
		.map(([name]) => name),
)

/**
 * The installed manifest of `name`, found along Node's resolution paths: a package whose exports
 * leave out `./package.json` (@noble/hashes) cannot be required for it
 */
function manifestOf(name: string): { types?: string; typings?: string } {
	const found = (require.resolve.paths(name) ?? [])
		.map((dir) => join(dir, name, "package.json"))
		.find((path) => existsSync(path))
	if (found === undefined) throw new Error(`${name} is not installed`)
	return JSON.parse(readFileSync(found, "utf8")) as { types?: string; typings?: string }
}

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) return entry.name === "__fixtures__" ? [] : sources(full)
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : []
	})
}

/** The packages a source imports, by name (scoped names whole), builtins and relative paths aside */
function imported(file: string): string[] {
	const text = readFileSync(file, "utf8")
	return [...text.matchAll(/^\s*(?:import|export)\b[^"'\n]*?from\s+["']([^"'.][^"']*)["']/gm)]
		.map((match) => match[1] as string)
		.filter((spec) => !spec.startsWith("node:") && !spec.startsWith("bun:") && spec !== "bun")
		.map((spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] as string)))
}

describe("package.json peers", () => {
	it("declare every package the shipped sources import", () => {
		const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(peers)])
		const missing = [...new Set(sources(join(ROOT, "src")).flatMap(imported))].filter((name) => !declared.has(name))
		expect(missing.sort()).toEqual([])
	})

	it("ship the types of every runtime dependency: a consumer's tsc checks comb's .ts sources (P5)", () => {
		const dependencies = pkg.dependencies ?? {}
		/* pluralize ships no types; the guard proves at least one dependency is checked */
		const untyped = Object.keys(dependencies).filter((name) => {
			const manifest = manifestOf(name)
			return !name.startsWith("@types/") && manifest.types === undefined && manifest.typings === undefined
		})
		expect(untyped.length).toBeGreaterThan(0)
		expect(untyped.filter((name) => !Object.hasOwn(dependencies, `@types/${name}`))).toEqual([])
	})

	it("declare as optional peers the packages the sources spawn, Atlas aside, which no package ships", () => {
		const spawned = new Set(
			sources(join(ROOT, "src")).flatMap((file) =>
				[...readFileSync(file, "utf8").matchAll(/\b(?:exec|run)\(\s*"([\w-]+)"\s*,\s*\[\s*(?:"([\w-]+)")?/g)].map(
					(match) => (match[1] === "bun" ? (match[2] as string) : (match[1] as string)),
				),
			),
		)
		spawned.delete("atlas")
		expect([...spawned].sort()).toEqual(["drizzle-kit", "wrangler"])
		for (const name of spawned) {
			expect(peers[name], name).toBeDefined()
			expect(optional.has(name), name).toBe(true)
		}
	})

	it("pin published dependencies to versions, never a workspace catalog an install cannot resolve", () => {
		expect(Object.entries(pkg.dependencies ?? {}).filter(([, range]) => range.startsWith("catalog:"))).toEqual([])
	})

	it("require zod, and keep @cloudflare/workers-types an optional peer", () => {
		expect(peers["zod"]).toBeDefined()
		expect(optional.has("zod")).toBe(false)
		expect(peers["@cloudflare/workers-types"]).toBeDefined()
		expect(optional.has("@cloudflare/workers-types")).toBe(true)
	})

	it("bound every peer below its next breaking release", () => {
		const unbounded = Object.entries(peers).filter(([, range]) => !/<\s*\d/.test(range))
		expect(unbounded).toEqual([])
	})

	it("are the ranges the README's peer table lists", () => {
		const readme = readFileSync(join(ROOT, "../../README.md"), "utf8")
		const section = readme.slice(readme.indexOf("Peer dependencies:"))
		const block = section.slice(0, section.indexOf("\n\n", section.indexOf("|")))
		const table = Object.fromEntries(
			[...block.matchAll(/^\| `([^`]+)`\s*\| `([^`]+)`\s*\|/gm)].map((match) => [match[1], match[2]]),
		)
		expect(table).toEqual(peers)
	})
})

/* the cursor seal's crypto: one copy across comb and the app, so the consumer installs it (user's decision) */
describe("package.json peers: the cursor seal", () => {
	it("requires @noble/ciphers and @noble/hashes as peers, not dependencies", () => {
		for (const name of ["@noble/ciphers", "@noble/hashes"]) {
			expect(peers[name], name).toBe(">=2.0.0 <3")
			expect(optional.has(name), name).toBe(false)
			expect(pkg.dependencies?.[name], name).toBeUndefined()
		}
	})
})
