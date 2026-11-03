/**
 * The consumer cells' stage: comb packed as it publishes (bun pm pack resolves catalog: ranges),
 * installed with npm into a fresh project under the OS temp dir, outside the repo and never a
 * link to the workspace, with each peer at the newest version comb's range admits (the repo's own
 * suites run the catalog's exact floor).
 */
import { spawnSync } from "node:child_process"
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
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
export const TOOLS = {
	/* a Worker's own types, which comb no longer peers on (K3 of r21) */
	"@cloudflare/workers-types": catalog["@cloudflare/workers-types"] as string,
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

/** `cmd args` in `cwd`, with a consumer's environment: none of the runner's vitest variables, `set` over it */
export function run(cwd: string, cmd: string, args: readonly string[], set: Record<string, string> = {}): Run {
	const env = {
		...Object.fromEntries(
			Object.entries(process.env).filter(([name]) => name !== "NODE_ENV" && !name.startsWith("VITEST")),
		),
		...set,
	}
	const result = spawnSync(cmd, args, { cwd, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 })
	return { output: `${result.stdout}${result.stderr}`, status: result.status ?? 1 }
}

/** Throw with the output unless the command exited 0 */
export function ok(result: Run, what: string): string {
	if (result.status !== 0) throw new Error(`${what} exited ${result.status}\n${result.output}`)
	return result.output
}

/* what a pack reads: the workspace's manifest and lockfile (catalog: resolves through them), the base tsconfig,
   and the README and LICENSE prepack copies in; then the package's manifest, tsconfigs, src and docs */
const ROOT_FILES = ["package.json", "bun.lock", "tsconfig.base.json", "README.md", "LICENSE"]
const CORE_FILES = ["package.json", "tsconfig.json", "tsconfig.strict.json", "tsconfig.types.json", "src", "docs"]
const MODULES = ["node_", "modules"].join("")

/**
 * comb packed by the release's own script (K1 of r20: the tarball it publishes), and the directory it
 * printed, under the OS temp dir. It packs a copy: bun pm pack walks every directory of the package, so
 * packing the live tree fails when a test removes its scratch directory mid-walk, and prepack would write
 * types/, README.md and LICENSE where other tests read. The copy is a workspace of the files git would
 * commit, as the release's checkout holds them, borrowing the repo's installed modules
 */
export function packedDir(): string {
	const copy = mkdtempSync(join(ROOT, ".tmp-pack-"))
	try {
		const listed = spawnSync(
			"git",
			[
				"ls-files",
				"-co",
				"--exclude-standard",
				"--",
				...ROOT_FILES,
				...CORE_FILES.map((file) => `packages/core/${file}`),
			],
			{ cwd: ROOT, encoding: "utf8" },
		)
		if (listed.status !== 0) throw new Error(`git ls-files exited ${listed.status}\n${listed.stderr}`)
		for (const file of listed.stdout.split("\n").filter((line) => line !== "")) {
			mkdirSync(dirname(join(copy, file)), { recursive: true })
			cpSync(join(ROOT, file), join(copy, file))
		}
		symlinkSync(join(ROOT, MODULES), join(copy, MODULES))
		symlinkSync(join(CORE, MODULES), join(copy, "packages/core", MODULES))
		const script = join(ROOT, ".github/scripts/pack-for-publish.sh")
		/* its stdout alone: bun echoes each pack script to stderr, after the directory the script prints */
		const packed = spawnSync("bash", [script, join(copy, "packages/core")], { cwd: copy, encoding: "utf8" })
		if (packed.status !== 0) {
			throw new Error(`pack-for-publish exited ${packed.status}\n${packed.stdout}${packed.stderr}`)
		}
		return packed.stdout.trim().split("\n").at(-1) as string
	} finally {
		rmSync(copy, { force: true, recursive: true })
	}
}

/** The tarball packedDir's pack wrote, beside the directory; remove its parent when done */
export function pack(): string {
	const out = dirname(packedDir())
	const tarball = readdirSync(out).find((file) => file.endsWith(".tgz"))
	if (tarball === undefined) throw new Error("bun pm pack wrote no tarball")
	return join(out, tarball)
}

export type Stage = { dir: string; dispose(): void }

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
	/* the globals `wrangler types` writes for the create-cloudflare project, from its bindings (K3 of r21) */
	if (existsSync(join(dir, "c3/wrangler.jsonc")))
		ok(run(join(dir, "c3"), "npx", ["wrangler", "types"]), "wrangler types")
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

/** comb's range for the peer `name` */
export const peerRange = (name: string): string => manifest.peerDependencies[name] as string

/** `name` taken out of the consumer in `dir`, its bin with it, as a project that never installed it */
export function removePackage(dir: string, name: string): void {
	rmSync(join(dir, "node_modules", name), { force: true, recursive: true })
	rmSync(join(dir, "node_modules", ".bin", name), { force: true })
}

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
