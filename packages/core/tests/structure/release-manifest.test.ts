/**
 * What the release publishes: the package as bun packs it, every catalog: and workspace: version
 * resolved (P2). `npm publish` in the package directory sent 0.8.0's devDependencies as catalog:.
 * 0.9.0's release failed in both publish steps, and its manifest would have lost the comb bin.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "../../../..")
const SCRIPT = join(ROOT, ".github/scripts/pack-for-publish.sh")
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
	const packed = spawnSync("bash", [SCRIPT, join(ROOT, "packages/core")], { encoding: "utf8" })
	expect(packed.status).toBe(0)
	const dir = packed.stdout.trim().split("\n").at(-1) as string
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
				const run = spawnSync("npm", ["publish", dir, "--dry-run", ...flagsOf(line)], { cwd: dir, encoding: "utf8" })
				expect(run.status, `${line.trim()}\n${run.stderr}`).toBe(0)
				/* any normalization npm applies to the manifest only warns; each one fails here */
				expect(run.stderr, line.trim()).not.toMatch(/^npm warn publish/m)
			}
		})
	}, 120_000)

	it("is dry-run published on every push, so a broken publish is red on main before a tag", () => {
		expect(CI).toMatch(/packed="\$\(\.github\/scripts\/pack-for-publish\.sh packages\/core\)"/)
		expect(PUBLISHES).toHaveLength(3)
		for (const line of PUBLISHES) expect(line).toMatch(/ --ignore-scripts\b/)
		expect(CI).toMatch(/^\s*npm publish "\$packed" --dry-run --ignore-scripts$/m)
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
