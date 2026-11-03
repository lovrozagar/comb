/**
 * What the release publishes: the package as bun packs it, every catalog: and workspace: version
 * resolved (P2). `npm publish` in the package directory sent 0.8.0's devDependencies as catalog:.
 * 0.9.0's release failed in both publish steps, and its manifest would have lost the comb bin.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { pack as packForConsumers, packedDir } from "../consumers/stage.ts"

const ROOT = join(import.meta.dirname, "../../../..")
const RELEASE = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")

/** Every `npm publish` line of the release, then of CI */
const PUBLISHES = [...RELEASE.split("\n"), ...CI.split("\n")].filter((line) => /^\s*npm publish\b/.test(line))

/** Every version a manifest's dependency fields name */
const versionsOf = (manifest: Record<string, unknown>) =>
	["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((field) =>
		Object.values((manifest[field] ?? {}) as Record<string, string>),
	)

/** Pack the package as the release does, run `check` on the packed directory, then remove it */
function withPacked(check: (dir: string) => void): void {
	const dir = packedDir()
	try {
		check(dir)
	} finally {
		rmSync(dirname(dir), { force: true, recursive: true })
	}
}

const manifestOf = (dir: string) =>
	JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>

/** A publish line's own flags; provenance needs CI's OIDC token, and every run here is a dry run */
const flagsOf = (line: string) =>
	line
		.trim()
		.split(/\s+/)
		.slice(3)
		.filter((flag) => flag !== "--provenance" && flag !== "--dry-run")
		.filter((flag, i, all) => flag !== "--tag" && all[i - 1] !== "--tag")

/**
 * A dry run of a publish line on `dir`, npm logged out on every machine as on CI. npm refuses even
 * a dry run of a version it has, so the candidate goes as a prerelease of it, as CI's dry run does.
 */
function dryRun(dir: string, line: string): { status: number | null; stderr: string; warnings: string[] } {
	const userconfig = join(dirname(dir), "empty.npmrc")
	writeFileSync(userconfig, "")
	const manifest = manifestOf(dir)
	if (!String(manifest["version"]).endsWith("-dry-run")) {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ ...manifest, version: `${String(manifest["version"])}-dry-run` }),
		)
	}
	const run = spawnSync("npm", ["publish", dir, "--dry-run", "--tag", "dry-run", ...flagsOf(line)], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, NPM_CONFIG_USERCONFIG: userconfig },
	})
	/* any normalization npm applies to the manifest only warns, and each one counts; the one warning a
	 * logged-out dry run always prints is not about the package */
	const warnings = run.stderr
		.split("\n")
		.filter((text) => text.startsWith("npm warn publish"))
		.filter((text) => !/^npm warn publish This command requires you to be logged in to \S+ \(dry-run\)$/.test(text))
	return { status: run.status, stderr: run.stderr, warnings }
}

/* every suite packs while others write scratch into packages/core: d7c28e0's verify failed when bun pm pack, walking
   the live tree, opened a directory a test had just removed. A directory it cannot open stands in for that one */
describe("a pack", () => {
	it("reads a copy, so a directory a test holds in the package never reaches it, and leaves the package as it was", () => {
		const core = join(ROOT, "packages/core")
		const held = mkdtempSync(join(core, ".tmp-held-"))
		chmodSync(held, 0o000)
		try {
			const dir = packedDir()
			rmSync(dirname(dir), { force: true, recursive: true })
			expect(["types", "README.md", "LICENSE"].filter((file) => existsSync(join(core, file)))).toEqual([])
		} finally {
			chmodSync(held, 0o700)
			rmSync(held, { force: true, recursive: true })
		}
	}, 120_000)
})

describe("the published package (P2)", () => {
	it("is packed with every catalog: and workspace: version resolved", () => {
		withPacked((dir) => {
			const manifest = manifestOf(dir)
			expect(manifest["version"]).toBe(manifestOf(join(ROOT, "packages/core"))["version"])
			expect(versionsOf(manifest).filter((version) => /^(?:catalog|workspace):/.test(version))).toEqual([])
		})
	}, 60_000)

	it("publishes from the packed directory as packed: no rerun script, no manifest npm rewrites", () => {
		withPacked((dir) => {
			/* npm 11+ drops a bin written `./path` from the manifest it publishes, and only warns */
			expect(manifestOf(dir)["bin"]).toEqual({ comb: "src/bin.ts" })
			for (const line of PUBLISHES) {
				const run = dryRun(dir, line)
				expect(run.status, `${line.trim()}\n${run.stderr}`).toBe(0)
				expect(run.warnings, line.trim()).toEqual([])
			}
		})
	}, 120_000)

	it("is dry-run published on every push, so a broken publish is red on main before a tag", () => {
		expect(CI).toMatch(/packed="\$\(\.github\/scripts\/pack-for-publish\.sh packages\/core\)"/)
		expect(PUBLISHES).toHaveLength(3)
		for (const line of PUBLISHES) expect(line).toMatch(/ --ignore-scripts\b/)
		expect(CI).toMatch(/^\s*npm publish "\$packed" --dry-run --ignore-scripts --tag dry-run$/m)
		expect(CI).toContain(`npm pkg set version="$(npm pkg get version | tr -d '"')-dry-run"`)
	})

	it("is published, and dry-run published, by one npm: each publishing job installs npm@latest first", () => {
		for (const workflow of [RELEASE, CI]) {
			const jobs = workflow.slice(workflow.indexOf("\njobs:\n")).split(/\n(?= {2}[\w-]+:\s*$)/m)
			for (const job of jobs.filter((text) => /^\s*npm publish\b/m.test(text))) {
				const install = job.search(/^\s*(?:- run: )?npm install -g npm@latest\s*$/m)
				expect(install, job.split("\n")[0]).toBeGreaterThan(-1)
				expect(install).toBeLessThan(job.search(/^\s*npm publish\b/m))
			}
		}
	})

	it("is what both registries' publish steps send, the npm one with provenance", () => {
		const publishes = RELEASE.split("\n").filter((line) => /^\s*npm publish\b/.test(line))
		expect(publishes).toHaveLength(2)
		for (const line of publishes) expect(line).toMatch(/npm publish "\$packed" /)
		expect(publishes.some((line) => line.includes("--provenance"))).toBe(true)
		expect(
			RELEASE.match(/packed="\$\("\$\{GITHUB_WORKSPACE\}\/\.github\/scripts\/pack-for-publish\.sh"/g),
		).toHaveLength(2)
	})
})

/** Every file under `dir`, relative to it */
const filesUnder = (dir: string): string[] =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)))
		.sort()

/** Each export of the packed `dir` that is not `{ types, default }` with its declaration under types/, or whose files `files` lacks */
function wrongExports(dir: string, files: string[]): string[] {
	return Object.entries(manifestOf(dir)["exports"] as Record<string, unknown>).flatMap(([subpath, target]) => {
		if (subpath === "./package.json")
			return target === "./package.json" ? [] : [`${subpath}: ${JSON.stringify(target)}`]
		const { default: source, types } = (target ?? {}) as { default?: string; types?: string }
		const expected = { types: source?.replace(/^\.\/src\//, "./types/").replace(/\.ts$/, ".d.ts"), default: source }
		if (JSON.stringify(target) !== JSON.stringify(expected)) return [`${subpath}: ${JSON.stringify(target)}`]
		return [types, source]
			.filter((file) => !files.includes((file as string).slice(2)))
			.map((file) => `${subpath}: ${file} not packed`)
	})
}

/** Each `sources` entry of a packed map that is absolute, leaves the package, or names a file `files` lacks */
function wrongSources(dir: string, files: string[], maps: string[]): string[] {
	return maps.flatMap((map) => {
		const { sourceRoot = "", sources } = JSON.parse(readFileSync(join(dir, map), "utf8")) as {
			sourceRoot?: string
			sources: string[]
		}
		return sources.flatMap((source) => {
			const target = relative(dir, resolve(dir, dirname(map), sourceRoot, source))
			if (isAbsolute(sourceRoot) || isAbsolute(source) || target.startsWith("..")) return [`${map}: ${source}`]
			return files.includes(target) ? [] : [`${map}: ${source} not packed`]
		})
	})
}

/*
 * K1 of r20: a consumer's tsc reads comb's declarations, emitted at pack under types/, and never
 * loads comb's .ts. Every check reads the package the release publishes, never the working tree,
 * where types/ never exists: each pack runs on its own copy of the package (packedDir).
 */
describe("the published declarations (K1 of r20)", () => {
	let dir: string
	let files: string[]
	beforeAll(() => {
		dir = packedDir()
		files = filesUnder(dir)
	}, 120_000)
	afterAll(() => rmSync(dirname(dir), { force: true, recursive: true }))

	/* the first condition that matches wins, and `default` always matches: `{ default, types }` hid every declaration in 1.6's first run */
	it("names each export's declaration first, under types/, and ships both targets", () => {
		expect(wrongExports(dir, files)).toEqual([])
		expect(Object.keys(manifestOf(dir)["exports"] as object).length).toBeGreaterThan(15)
	})

	/* anyrow bug #11's class: a map that names a path outside the package sends go-to-definition nowhere */
	it("maps each declaration to a source inside the package, and the source ships", () => {
		const declarations = files.filter((file) => file.startsWith("types/") && file.endsWith(".d.ts"))
		const maps = files.filter((file) => file.endsWith(".d.ts.map"))
		expect(declarations.length).toBeGreaterThan(15)
		expect(maps.toSorted()).toEqual(declarations.map((file) => `${file}.map`).toSorted())
		expect(wrongSources(dir, files, maps)).toEqual([])
	})

	/* type-references.test.ts holds the source to it; the emit could still add one, and a consumer's tsc reads these */
	it("reference no types package with a triple-slash directive", () => {
		const declarations = files.filter((file) => file.endsWith(".d.ts"))
		const referencing = declarations.filter((file) =>
			/^\/\/\/\s*<reference\s+types=/m.test(readFileSync(join(dir, file), "utf8")),
		)
		expect(declarations.length).toBeGreaterThan(15)
		expect(referencing).toEqual([])
	})

	/* the consumer cells prove the tarball the release publishes, declarations and all, not a pack of their own */
	it("is the tarball the consumer suite installs", () => {
		const tarball = packForConsumers()
		try {
			const listed = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" })
				.stdout.split("\n")
				.filter((line) => line !== "" && !line.endsWith("/"))
				.map((line) => line.replace(/^package\//, ""))
				.sort()
			expect(listed).toEqual(files)
			expect(listed).toContain("types/index.d.ts")
		} finally {
			rmSync(dirname(tarball), { force: true, recursive: true })
		}
	}, 120_000)
})
