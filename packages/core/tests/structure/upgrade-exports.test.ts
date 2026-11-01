/**
 * K3 of r18: the README's newest "Upgrading to" section names every export the package adds or
 * removes since the release it upgrades from, so it never promises an export that is not there, nor
 * leaves one out. The release's exports are checked in (__snapshots__/released-exports.json); after
 * a release, regenerate it from the tag.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type Exports, exportsOf } from "./support/exports-of.ts"

const ROOT = join(import.meta.dirname, "../..")
const RELEASED = JSON.parse(readFileSync(join(import.meta.dirname, "__snapshots__/released-exports.json"), "utf8")) as {
	exports: Exports
	version: string
}
const README = readFileSync(join(ROOT, "../../README.md"), "utf8")

/** The newest "## Upgrading to X" section, and X */
function newestUpgrade(): { section: string; version: string } {
	const at = README.indexOf("\n## Upgrading to ")
	const next = README.indexOf("\n## ", at + 1)
	const section = README.slice(at, next === -1 ? undefined : next)
	return { section, version: /^\n## Upgrading to (\S+)/.exec(section)?.[1] as string }
}

/** Each name `to` has and `from` lacks, by subpath */
const changed = (from: Exports, to: Exports): string[] =>
	Object.entries(to).flatMap(([subpath, names]) => names.filter((name) => !(from[subpath] ?? []).includes(name)))

describe("the newest upgrade section's exports", () => {
	const now = exportsOf(ROOT)
	const { section, version } = newestUpgrade()

	it("upgrades from the release the exports are checked in from", () => {
		const [major, minor] = version.split(".").map(Number)
		const [wasMajor, wasMinor] = RELEASED.version.split(".").map(Number)
		expect([major, minor], `Upgrading to ${version} from ${RELEASED.version}`).not.toEqual([wasMajor, wasMinor])
		expect(major === wasMajor ? (minor as number) - (wasMinor as number) : 1).toBe(1)
	})

	it("names each export added or removed since then", () => {
		const unnamed = [...changed(RELEASED.exports, now), ...changed(now, RELEASED.exports)].filter(
			(name) => !section.includes(`\`${name}\``),
		)
		expect([...new Set(unnamed)]).toEqual([])
	})
})
