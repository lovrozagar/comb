/**
 * KT3 of r22b: the released-exports guard hashed each export's own declaration, so a change inside
 * an unexported type it names (`BaseConstraints` under `TextConstraints`) left its hash as it was,
 * and the newest Upgrading section's `Changed:` list missed a change consumers' compilers see.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { apiOf } from "./support/exports-of.ts"

const made: string[] = []
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const BASE = `/** what every text column takes */
export type Base = { autogenerate?: boolean; inner: Inner }
type Inner = { label: string }
`

/** A package whose root exports `Text`, which names the unexported `Base`, and `UsesShared`, which names the exported `Shared` */
function fixture(base: string, shared = "export type Shared = { s: string }\n", inner = false): string {
	const root = mkdtempSync(join(tmpdir(), "comb-exports-of-"))
	made.push(root)
	mkdirSync(join(root, "src"))
	const compilerOptions = {
		allowImportingTsExtensions: true,
		declaration: true,
		module: "esnext",
		moduleResolution: "bundler",
		noEmit: true,
		skipLibCheck: true,
		strict: true,
		target: "es2023",
		types: [],
	}
	const files = {
		"package.json": JSON.stringify({
			exports: { ".": { default: "./src/index.ts", types: "./types/index.d.ts" }, "./package.json": "./package.json" },
		}),
		"src/base.ts": base,
		"src/index.ts": `import type { Base } from "./base.ts"
import type { Shared } from "./shared.ts"
export type { Shared } from "./shared.ts"
${inner ? 'export type { Inner } from "./base.ts"\n' : ""}export type Text = Base & { max: number }
export type UsesShared = { shared: Shared }
`,
		"src/shared.ts": shared,
		"tsconfig.json": JSON.stringify({ compilerOptions, include: ["src"] }),
		"tsconfig.strict.json": JSON.stringify({ extends: "./tsconfig.json" }),
	}
	for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text)
	return root
}

const hashes = (root: string) => apiOf(root).exports["."] as Record<string, string>

describe("an export's hash covers what a consumer's compiler reads for it (KT3; siblings: comments, exported types)", () => {
	it("changes when an unexported type it names changes, however deep", () => {
		const before = hashes(fixture(BASE))
		expect(Object.keys(before)).toEqual(["Shared", "Text", "UsesShared"])
		const dropped = hashes(fixture(BASE.replace("autogenerate?: boolean; ", "")))
		expect(dropped["Text"]).not.toBe(before["Text"])
		const deeper = hashes(fixture(BASE.replace("label: string", "label: number")))
		expect(deeper["Text"]).not.toBe(before["Text"])
	})

	it("keeps every hash when only a comment changes", () => {
		expect(hashes(fixture(BASE.replace("what every text column takes", "what a text column takes")))).toEqual(
			hashes(fixture(BASE)),
		)
	})

	it("changes each export that names a changed exported type, and none when a type only becomes exported", () => {
		const before = hashes(fixture(BASE))
		const after = hashes(fixture(BASE, "export type Shared = { s: number }\n"))
		expect({
			shared: after["Shared"] === before["Shared"],
			uses: after["UsesShared"] === before["UsesShared"],
		}).toEqual({
			shared: false,
			uses: false,
		})
		/* 0.21 exports types 0.20.1 kept internal (KT6): what a consumer reads for Text stays as it was */
		const published = hashes(fixture(BASE.replace("type Inner", "export type Inner"), undefined, true))
		expect(published["Text"]).toBe(before["Text"])
	})
})

const MEMBERS = `type Hidden = { inner: string }
export class Kept extends Error {
	#secret = 1
	private quiet = 2
	static made = 3
	column?: string
	toJSON(): object { return {} }
}
export interface Wide extends Narrow { extra?: number }
interface Narrow { name: string }
export type Mixed = Narrow & Partial<{ later: number }> & { required: Hidden }
export type Either = { kind: "a"; a?: string; both: number } | { kind: "b"; both?: number }
export type Mapped = { [K in "x"]: string }
`

describe("the members of each type an export reaches, as a consumer's compiler reads them", () => {
	it("lists each public member optional or required, through bases, intersections, unions and Partial", () => {
		const root = fixture(BASE)
		writeFileSync(join(root, "src/index.ts"), MEMBERS)
		const { members } = apiOf(root)
		expect(members).toEqual({
			Either: { both: "optional", kind: "required" },
			Hidden: { inner: "required" },
			Kept: { column: "optional", toJSON: "required" },
			Mixed: { later: "optional", name: "required", required: "required" },
			Narrow: { name: "required" },
			Wide: { extra: "optional", name: "required" },
		})
	})
})
