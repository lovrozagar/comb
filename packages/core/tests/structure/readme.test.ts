/**
 * The README is the manual an agent works from, so its code compiles and its links resolve. Each
 * ```ts block is one module, compiled against comb's real exports under the strict flags a
 * consumer may set, with the Workers and Node types loaded together as a Worker that runs codegen
 * would. A `<!-- ts-context … -->` comment right above a block declares what the snippet assumes
 * (a db, a table, a request) without showing it.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "../..")
const REPO = join(ROOT, "../..")
const README = readFileSync(join(REPO, "README.md"), "utf8")
const TSC = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")
/* inside the package, so drizzle, zod and the Workers types resolve from its dependencies */
const WORK = join(ROOT, `.readme-typecheck-${process.pid}`)

afterAll(() => rmSync(WORK, { force: true, recursive: true }))

type Block = { code: string; context: string; line: number }

/** Every ```ts block with the line it starts on and the context comment right above it */
function blocks(text: string): Block[] {
	const pattern = /(?:<!-- ts-context\n([\s\S]*?)\n-->\n\n)?```ts\n([\s\S]*?)\n```/g
	return [...text.matchAll(pattern)].map((match) => ({
		code: match[2] as string,
		context: match[1] ?? "",
		line: text.slice(0, match.index + match[0].indexOf("```ts")).split("\n").length + 1,
	}))
}

const CONFIG = {
	compilerOptions: {
		allowImportingTsExtensions: true,
		exactOptionalPropertyTypes: true,
		module: "esnext",
		moduleResolution: "bundler",
		noEmit: true,
		noPropertyAccessFromIndexSignature: true,
		noUncheckedIndexedAccess: true,
		paths: { "@lovrozagar/comb": ["../src/index.ts"], "@lovrozagar/comb/*": ["../src/*"] },
		skipLibCheck: true,
		strict: true,
		target: "es2023",
		types: ["@cloudflare/workers-types", "node"],
	},
	include: ["*.ts"],
}

describe("README code", () => {
	it("compiles, every ts block, against the real exports", () => {
		const found = blocks(README)
		expect(found.length).toBeGreaterThan(15)
		mkdirSync(WORK, { recursive: true })
		for (const block of found) {
			writeFileSync(join(WORK, `readme_L${block.line}.ts`), `${block.context}\n${block.code}\nexport {}\n`)
		}
		writeFileSync(join(WORK, "tsconfig.json"), JSON.stringify(CONFIG))
		const tsc = spawnSync(process.execPath, [TSC, "-p", join(WORK, "tsconfig.json")], { encoding: "utf8" })
		expect(tsc.stdout.split("\n").filter((line) => line.includes("error TS"))).toEqual([])
		expect(tsc.status).toBe(0)
	}, 120_000)
})

/** GitHub's anchor for a heading */
const slug = (heading: string) =>
	heading
		.trim()
		.toLowerCase()
		.replace(/[^\w\- ]/g, "")
		.replaceAll(" ", "-")

describe("README package exports table", () => {
	it("lists every export subpath, and no other", () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { exports: Record<string, string> }
		const subpaths = Object.keys(manifest.exports)
			.filter((key) => key !== "./package.json")
			.map((key) => (key === "." ? "@lovrozagar/comb" : `@lovrozagar/comb/${key.slice(2)}`))
		const section = README.slice(README.indexOf("## Package exports"), README.indexOf("## Repository layout"))
		const listed = [...section.matchAll(/^\| `(@lovrozagar\/comb[^`]*)`/gm)].map((match) => match[1])
		expect(listed.toSorted()).toEqual(subpaths.toSorted())
	})
})

describe("README links", () => {
	const links = [...README.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] as string)
	const anchors = new Set([...README.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1] as string)))

	it("point at files that exist", () => {
		const local = links.filter((link) => !/^(?:https?:|mailto:|#)/.test(link))
		expect(local.length).toBeGreaterThan(0)
		expect(local.filter((link) => !existsSync(join(REPO, link.split("#")[0] as string)))).toEqual([])
	})

	it("point at headings that exist", () => {
		const inPage = links.filter((link) => link.startsWith("#")).map((link) => link.slice(1))
		expect(inPage.length).toBeGreaterThan(0)
		expect(inPage.filter((anchor) => !anchors.has(anchor))).toEqual([])
	})
})
