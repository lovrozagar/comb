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
import semver from "semver"

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

const WORKERS_TYPES = "@cloudflare/workers-types"

/** The lowest version `range` admits */
export function floorOf(range: string): string {
	const floor = semver.minVersion(range)
	if (floor === null) throw new Error(`${range} admits no version`)
	return floor.version
}

/* every version each peer range admits, as tests/structure/peers.test.ts holds it to the ranges */
const REGISTRY = JSON.parse(
	readFileSync(join(CORE, "tests/structure/__snapshots__/peer-registry.json"), "utf8"),
) as Record<string, { admitted: string[] }>

/** Every version comb's range for `name` admits, oldest first, as the registry was recorded */
export const admittedOf = (name: string): string[] => REGISTRY[name]?.admitted ?? []

/**
 * Which version of each peer a stage installs: the newest its range admits, the range's floor
 * (K8 of r20), or the newest but for the exact versions `pin` names. Each is an exact version, never
 * a range npm resolves: drizzle's `1.0.0-rc.N-<hash>` branch builds rank above its tagged rcs.
 */
export type Versions = "floor" | "newest" | { pin: Record<string, string> }

function versionOf(name: string, versions: Versions): string {
	if (versions === "floor") return floorOf(manifest.peerDependencies[name] as string)
	const pinned = versions === "newest" ? undefined : versions.pin[name]
	const newest = pinned ?? admittedOf(name).at(-1)
	if (newest === undefined) throw new Error(`the recorded registry admits no ${name}`)
	return newest
}

/**
 * A fresh consumer with comb from `tarball`, its required peers, the optional ones when `all`, and
 * the tools, each peer at the exact version `versions` picks
 */
export function stage(
	tarball: string,
	peers: "all" | "required",
	files: Record<string, string> = {},
	versions: Versions = "newest",
): Stage {
	const label = typeof versions === "string" ? versions : "pinned"
	const dir = mkdtempSync(join(tmpdir(), `comb-consumer-${peers}-${label}-`))
	const wanted = Object.keys(manifest.peerDependencies).filter(
		(name) => peers === "all" || !OPTIONAL_PEERS.includes(name),
	)
	const dependencies = Object.fromEntries([
		["@lovrozagar/comb", `file:${tarball}`],
		...wanted.map((name) => [name, versionOf(name, versions)]),
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
	/* the floor of comb's workers-types range beside it, alone, for the cell that types against it (R4 of plan 17) */
	if (wanted.includes(WORKERS_TYPES)) {
		const floor = `${WORKERS_TYPES}@${floorOf(manifest.peerDependencies[WORKERS_TYPES] as string)}`
		ok(run(dir, "npm", ["install", "--prefix", "floor", "--no-audit", "--no-fund", "--loglevel=error", floor]), floor)
	}
	return { dir, dispose: () => rmSync(dir, { force: true, recursive: true }) }
}

/**
 * A fresh project that runs `line`, a README install line, verbatim but for comb itself, which is
 * `tarball` (K3 of r20): the README's line, not comb's ranges, decides each peer's version
 */
export function stageLine(tarball: string, line: string): Stage {
	const dir = mkdtempSync(join(tmpdir(), "comb-consumer-readme-"))
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "comb-consumer", private: true, type: "module" }))
	const [cmd, ...args] = line.split(" ").map((word) => (word === "@lovrozagar/comb" ? tarball : word))
	ok(run(dir, cmd as string, args), line)
	return { dir, dispose: () => rmSync(dir, { force: true, recursive: true }) }
}

/** The version of `name` installed in `dir` */
export const installedVersion = (dir: string, name: string): string =>
	(JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8")) as { version: string }).version

/** comb's range for each of its required peers */
export const REQUIRED_PEERS: Record<string, string> = Object.fromEntries(
	Object.entries(manifest.peerDependencies).filter(([name]) => !OPTIONAL_PEERS.includes(name)),
)

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
