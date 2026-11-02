/**
 * K3 of r18 and r19: the README's newest "Upgrading to" section lists exactly the exports the package
 * adds, removes or changes since the release it upgrades from, so it never promises an export that
 * is not there, nor leaves one out, nor hides a changed signature. The release's exports, each with a
 * hash of its emitted declaration, are checked in (__snapshots__/released-exports.json); after a
 * release, regenerate them from the tag with support/write-released-exports.ts.
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

/** Each name `to` has and `from` lacks, sorted, once */
const missingFrom = (from: Exports, to: Exports): string[] => {
	const names = Object.entries(to).flatMap(([subpath, each]) =>
		Object.keys(each).filter((name) => from[subpath]?.[name] === undefined),
	)
	return [...new Set(names)].sort()
}

/** Each name both have whose declaration differs, sorted, once */
const differing = (from: Exports, to: Exports): string[] => {
	const names = Object.entries(to).flatMap(([subpath, each]) =>
		Object.entries(each)
			.filter(([name, hash]) => (from[subpath]?.[name] ?? hash) !== hash)
			.map(([name]) => name),
	)
	return [...new Set(names)].sort()
}

/** The backticked names on the section's one `label:` line, sorted; `none.` names none */
function listed(section: string, label: string): string[] {
	const lines = [...section.matchAll(new RegExp(`^ *${label}: (.+)$`, "gm"))]
	expect(lines, `one "${label}:" line in the section`).toHaveLength(1)
	const names = (lines[0]?.[1] ?? "").matchAll(/`([^`]+)`/g)
	return [...names].map((match) => match[1] as string).sort()
}

describe("the newest upgrade section's exports", () => {
	const now = exportsOf(ROOT)
	const { section, version } = newestUpgrade()

	/* right after a release the newest section is the release's own, and the snapshot is regenerated from its tag */
	const [major, minor] = version.split(".").map(Number)
	const [wasMajor, wasMinor] = RELEASED.version.split(".").map(Number)
	const released = major === wasMajor && minor === wasMinor
	const since = {
		changed: differing(RELEASED.exports, now),
		new: missingFrom(RELEASED.exports, now),
		removed: missingFrom(now, RELEASED.exports),
	}

	it("upgrades from the release the exports are checked in from, or is that release's own", () => {
		expect(
			released || (major === wasMajor ? (minor as number) - (wasMinor as number) : 1) === 1,
			`Upgrading to ${version} from ${RELEASED.version}`,
		).toBe(true)
	})

	it("lists exactly what changed since then; nothing has, while the section is the release's own", () => {
		/* an export changed after the release opens the next version's section, which lists it */
		const lists = released
			? { changed: [], new: [], removed: [] }
			: {
					changed: listed(section, "Changed"),
					new: listed(section, "New exports"),
					removed: listed(section, "Removed"),
				}
		expect(lists, `changed since ${RELEASED.version}, against "Upgrading to ${version}"`).toEqual(since)
	})
})
