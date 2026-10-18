/**
 * The API a consumer compiles against, one snapshot per export subpath: the entry's emitted
 * declarations and every local declaration file they reach. comb ships TypeScript source, so the
 * declarations are emitted here from tsconfig.strict.json (isolatedDeclarations keeps them
 * faithful to the source). A change to a snapshot is an API change and belongs in a commit of
 * its own; `vitest -u` rewrites them.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "../..")
const TSC = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { exports: Record<string, string> }

let out: string

beforeAll(() => {
	out = mkdtempSync(join(tmpdir(), "comb-api-"))
	const args = [
		"-p",
		join(ROOT, "tsconfig.strict.json"),
		"--noEmit",
		"false",
		"--emitDeclarationOnly",
		"--rootDir",
		join(ROOT, "src"),
		"--outDir",
		out,
	]
	const tsc = spawnSync(process.execPath, [TSC, ...args], { encoding: "utf8" })
	if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.stdout}${tsc.stderr}`)
}, 120_000)

afterAll(() => rmSync(out, { force: true, recursive: true }))

/** The emitted declaration file for a source path under src/ */
const declarationOf = (source: string) => join(out, source.replace(/^\.?\/?src\//, "").replace(/\.ts$/, ".d.ts"))

/** The local specifiers a declaration file imports or re-exports */
function localSpecifiers(text: string): string[] {
	return [...text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)].map((match) => match[1] as string)
}

/** The entry's declarations and every local one they reach, each under its path */
function surface(entry: string): string {
	const seen = new Set<string>()
	const queue = [declarationOf(entry)]
	const parts: string[] = []
	while (queue.length > 0) {
		const file = queue.shift() as string
		if (seen.has(file) || !existsSync(file)) continue
		seen.add(file)
		const text = readFileSync(file, "utf8")
		parts.push(`// ${relative(out, file)}\n${text}`)
		for (const spec of localSpecifiers(text)) queue.push(resolve(dirname(file), spec.replace(/\.ts$/, ".d.ts")))
	}
	return parts.join("\n")
}

const entries = Object.entries(manifest.exports).filter(
	([key, value]) => key !== "./package.json" && value.endsWith(".ts"),
)

describe("public API declarations", () => {
	it("covers every TypeScript export subpath", () => {
		expect(entries.length).toBeGreaterThan(15)
	})

	it.each(entries)("%s", async (subpath, source) => {
		const name = subpath === "." ? "index" : subpath.slice(2).replaceAll("/", "__")
		await expect(surface(source)).toMatchFileSnapshot(`__snapshots__/api/${name}.d.ts.txt`)
	})
})
