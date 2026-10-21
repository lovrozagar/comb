/**
 * What the release publishes: the package as bun packs it, every catalog: and workspace: version
 * resolved (P2). `npm publish` in the package directory sent 0.8.0's devDependencies as catalog:.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "../../../..")
const SCRIPT = join(ROOT, ".github/scripts/pack-for-publish.sh")
const RELEASE = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")

/** Every version a manifest's dependency fields name */
const versionsOf = (manifest: Record<string, unknown>) =>
	["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((field) =>
		Object.values((manifest[field] ?? {}) as Record<string, string>),
	)

describe("the published package (P2)", () => {
	it("is packed with every catalog: and workspace: version resolved", () => {
		const packed = spawnSync("bash", [SCRIPT, join(ROOT, "packages/core")], { encoding: "utf8" })
		expect(packed.status).toBe(0)
		const dir = packed.stdout.trim().split("\n").at(-1) as string
		try {
			const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>
			const source = JSON.parse(readFileSync(join(ROOT, "packages/core/package.json"), "utf8")) as Record<
				string,
				unknown
			>
			expect(manifest["version"]).toBe(source["version"])
			expect(versionsOf(manifest).filter((version) => /^(?:catalog|workspace):/.test(version))).toEqual([])
		} finally {
			rmSync(dirname(dir), { force: true, recursive: true })
		}
	}, 60_000)

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
