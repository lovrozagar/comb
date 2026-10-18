/**
 * The consumer cells' stage: comb packed as it publishes (bun pm pack resolves catalog: ranges),
 * installed with npm into a fresh project under the OS temp dir, outside the repo and never a
 * link to the workspace, with each peer at the newest version comb's range admits (the repo's own
 * suites run the catalog's exact floor).
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const CORE = join(import.meta.dirname, "../..")
const ROOT = join(CORE, "../..")

type Manifest = {
	exports: Record<string, string>
	peerDependencies: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const manifest = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as Manifest
const catalog = (
	JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces: { catalog: Record<string, string> } }
).workspaces.catalog

/** The tools a consumer builds with, pinned */
const TOOLS = {
	"@types/node": catalog["@types/node"] as string,
	tsx: "4.23.15",
	typescript: catalog["typescript"] as string,
	vite: "8.3.4",
	wrangler: catalog["wrangler"] as string,
}

export const OPTIONAL_PEERS: string[] = Object.entries(manifest.peerDependenciesMeta ?? {})
	.filter(([, meta]) => meta.optional === true)
	.map(([name]) => name)

/** Every subpath a consumer imports, as a specifier */
export const SUBPATHS: string[] = Object.keys(manifest.exports)
	.filter((key) => key !== "./package.json")
	.map((key) => (key === "." ? "@lovrozagar/comb" : `@lovrozagar/comb/${key.slice(2)}`))

export type Run = { output: string; status: number }

/** `cmd args` in `cwd`, with a consumer's environment: none of the runner's vitest variables */
export function run(cwd: string, cmd: string, args: readonly string[]): Run {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => name !== "NODE_ENV" && !name.startsWith("VITEST")),
	)
	const result = spawnSync(cmd, args, { cwd, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 })
	return { output: `${result.stdout}${result.stderr}`, status: result.status ?? 1 }
}

/** Throw with the output unless the command exited 0 */
export function ok(result: Run, what: string): string {
	if (result.status !== 0) throw new Error(`${what} exited ${result.status}\n${result.output}`)
	return result.output
}

/** comb packed into a fresh directory, and the tarball's path */
export function pack(): string {
	const out = mkdtempSync(join(tmpdir(), "comb-pack-"))
	ok(run(CORE, "bun", ["pm", "pack", "--destination", out]), "bun pm pack")
	/* prepack copied these in for the tarball; the tree keeps none */
	rmSync(join(CORE, "README.md"), { force: true })
	rmSync(join(CORE, "LICENSE"), { force: true })
	const tarball = readdirSync(out).find((file) => file.endsWith(".tgz"))
	if (tarball === undefined) throw new Error("bun pm pack wrote no tarball")
	return join(out, tarball)
}

export type Stage = { dir: string; dispose(): void }

/** A fresh consumer with comb from `tarball`, its required peers, the optional ones when `all`, and the tools */
export function stage(tarball: string, peers: "all" | "required", files: Record<string, string> = {}): Stage {
	const dir = mkdtempSync(join(tmpdir(), `comb-consumer-${peers}-`))
	const wanted = Object.keys(manifest.peerDependencies).filter(
		(name) => peers === "all" || !OPTIONAL_PEERS.includes(name),
	)
	const dependencies = Object.fromEntries([
		["@lovrozagar/comb", `file:${tarball}`],
		/* each peer by comb's own range, as a consumer's install resolves it: the newest it admits */
		...wanted.map((name) => [name, manifest.peerDependencies[name] as string]),
	])
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ dependencies, devDependencies: TOOLS, name: "comb-consumer", private: true, type: "module" }),
	)
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true })
		writeFileSync(join(dir, path), text)
	}
	ok(run(dir, "npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]), "npm install")
	return { dir, dispose: () => rmSync(dir, { force: true, recursive: true }) }
}

/** A script that imports every subpath and prints `OK <spec>` or `FAIL <spec> <reason>` for each */
export const IMPORT_ALL = `const specs = ${JSON.stringify(SUBPATHS)}
for (const spec of specs) {
	try {
		await import(spec)
		console.log("OK", spec)
	} catch (error) {
		console.log("FAIL", spec, String(error?.message ?? error).split("\\n")[0])
	}
}
`

/** The subpaths that failed to import in an import-all run */
export function failures(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.startsWith("FAIL "))
		.map((line) => line.split(" ")[1] as string)
}
