/**
 * KT9 of r22b: every consumer installs comb's `dependencies`, so each must be one its shipped files
 * need: a package a shipped source file imports, or an `@types` package for a module a shipped source
 * file or declaration names. A consumer's tsc reads comb's types/, which no longer names pluralize,
 * but an install with no types/ (a `file:` or git install, which never ran prepack) compiles comb's
 * source, and without `@types/pluralize` fails it with TS7016 (the consumer cell "falls back to
 * comb's source"), so `@types/pluralize` stays a dependency.
 */
import { matchesGlob } from "node:path"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { withEmitted } from "./support/declarations.ts"

const ROOT = join(import.meta.dirname, "../..")
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
	dependencies?: Record<string, string>
	files: string[]
}

/* a static import or export, a dynamic import, and a side-effect import */
const SPECIFIER = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm

/** The package a bare specifier names: `@scope/name` or `name`, without a subpath */
const packageOf = (specifier: string): string =>
	specifier
		.split("/")
		.slice(0, specifier.startsWith("@") ? 2 : 1)
		.join("/")

/** Every package the files under `dir` ending in `suffix`, and kept by `keep`, import */
function packagesIn(dir: string, suffix: string, keep: (path: string) => boolean = () => true): Set<string> {
	const found = new Set<string>()
	const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(suffix))
	for (const file of files.filter((path) => keep(join(dir, path)))) {
		for (const match of readFileSync(join(dir, file), "utf8").matchAll(SPECIFIER)) {
			const specifier = match[1] ?? match[2] ?? match[3] ?? ""
			if (!specifier.startsWith(".") && !specifier.startsWith("node:")) found.add(packageOf(specifier))
		}
	}
	return found
}

/* the source a pack ships: src/ less what `files` leaves out */
const EXCLUDED = manifest.files.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1))
const shipped = (path: string) => !EXCLUDED.some((pattern) => matchesGlob(relative(ROOT, path), pattern))

/** The module an `@types` package types: `@types/scope__name` types `@scope/name` */
const typedBy = (name: string): string | undefined => {
	if (!name.startsWith("@types/")) return undefined
	const bare = name.slice("@types/".length)
	return bare.includes("__") ? `@${bare.replace("__", "/")}` : bare
}

describe("comb's dependencies are what its shipped files need (KT9; sibling: an @types package)", () => {
	it("holds each to a shipped import, and an @types one to a shipped source or declaration naming its module", () => {
		const imported = packagesIn(join(ROOT, "src"), ".ts", shipped)
		const declared = withEmitted(ROOT, ({ dir }) => packagesIn(dir, ".d.ts"))
		/* the scans see what they must: pluralize is imported by codegen, zod named by the declarations */
		expect([imported.has("pluralize"), declared.has("zod"), imported.has("vitest")]).toEqual([true, true, false])
		const unneeded = Object.keys(manifest.dependencies ?? {}).filter((name) => {
			const module = typedBy(name)
			return module === undefined ? !imported.has(name) : !imported.has(module) && !declared.has(module)
		})
		expect(unneeded).toEqual([])
	})
})
