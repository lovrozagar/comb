/**
 * Whole projects for `comb codegen`: written inside the package, so their imports of comb and
 * drizzle resolve as an installed app's would, run through the real CLI, and typechecked under the
 * strict flags a consumer may set.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { afterEach, expect } from "vitest"
import { runCli } from "../../../src/cli/index.ts"

const CORE = path.join(import.meta.dirname, "../../..")

const made: string[] = []

/** Remove every project the calling suite made, after each of its tests */
export function useProjects(): void {
	afterEach(() => {
		for (const dir of made.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
	})
}

/** A project of `files`, beside a package.json, in a fresh directory inside the package */
export function project(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(CORE, ".tmp-codegen-"))
	made.push(dir)
	const all = { "package.json": JSON.stringify({ name: "app", private: true, type: "module" }), ...files }
	for (const [name, text] of Object.entries(all)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
		fs.writeFileSync(path.join(dir, name), text)
	}
	return dir
}

/** `comb codegen` in `dir` with `args`: its exit code and what it wrote to stderr */
export async function runCodegen(dir: string, args: readonly string[] = []): Promise<{ code: number; err: string }> {
	const errors: string[] = []
	const io = { cwd: dir, err: (line: string) => errors.push(line), out: () => undefined }
	const code = await runCli(["codegen", ...args], io)
	return { code, err: errors.join("\n") }
}

/** `comb codegen` in `dir`, which must succeed */
export async function codegen(dir: string, args: readonly string[] = []): Promise<void> {
	const { code, err } = await runCodegen(dir, args)
	expect(code, err).toBe(0)
}

export const read = (dir: string, file: string): string => fs.readFileSync(path.join(dir, file), "utf8")

export const exportsOf = (dir: string): Record<string, string> =>
	(JSON.parse(read(dir, "package.json")) as { exports: Record<string, string> }).exports

/** The generated files of `dir`, relative to it */
export const generatedFiles = (dir: string): string[] =>
	fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.includes(".gen."))
		.map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
		.sort()

/** tsc over every generated file of the project under the strict flags a consumer may set: its imports must resolve */
export function typecheck(dir: string, extra: readonly string[] = []): string {
	const generated = fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".gen.ts"))
		.map((entry) => path.join(entry.parentPath, entry.name))
	fs.writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				allowImportingTsExtensions: true,
				exactOptionalPropertyTypes: true,
				module: "preserve",
				moduleResolution: "bundler",
				noEmit: true,
				noFallthroughCasesInSwitch: true,
				noImplicitReturns: true,
				noPropertyAccessFromIndexSignature: true,
				noUncheckedIndexedAccess: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				skipLibCheck: true,
				strict: true,
				target: "esnext",
				verbatimModuleSyntax: true,
			},
			files: [...generated, ...extra.map((file) => path.join(dir, file))],
		}),
	)
	const ran = spawnSync("bunx", ["tsc", "-p", path.join(dir, "tsconfig.json")], { cwd: CORE, encoding: "utf8" })
	return `${ran.stdout}${ran.stderr}`.trim()
}
