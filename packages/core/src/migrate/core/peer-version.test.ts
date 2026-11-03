import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import semver from "semver"
import { afterAll, describe, expect, it } from "vitest"
import { OPTIONAL_PEER_RANGES } from "./optional-peer.ts"
import { admits, installedVersion } from "./peer-version.ts"

/* K2 of r21: each peer's newer majors, its commit builds and prereleases, against semver's own answer */
const VERSIONS = [
	"0.0.3",
	"0.0.4",
	"0.2.3",
	"0.2.9",
	"0.3.0",
	"0.17.3",
	"0.17.4",
	"0.17.9",
	"0.18.0",
	"0.18.0-pre.1",
	"1.0.0-beta.1",
	"1.0.0-rc.3",
	"1.0.0-rc.4",
	"1.0.0-rc.4-0a1b2c3",
	"1.0.0-rc.4.1",
	"1.0.0-rc.5",
	"1.0.0-rc.6",
	"1.0.0-rc",
	"1.0.0-zeta",
	"1.0.0-1",
	"1.0.0",
	"1.0.0+build.1",
	"1.2.3",
	"2.0.0",
	"3.4.8",
	"3.4.9",
	"3.9.0",
	"4.0.0",
	"4.0.0-rc.1",
	"4.146.0",
	"4.147.0",
	"4.200.1",
	"5.0.0",
	"17.7.3",
	"17.7.4",
	"17.8.2",
	"17.9.0-rc.1",
	"18.2.2",
	"28.0.0",
	"28.1.0",
	"29.0.0",
	"5.20261001.1",
	"5.20261101.0",
	"6.0.0",
	"not-a-version",
]

/* the forms comb's ranges may take besides the ones they take today */
const OTHER_RANGES = ["^0.2.3", "^0.0.3", "<=1.2.3", ">1.0.0-rc.1", "=1.0.0", ">=17.7", "1.0.0-rc.4 || >=3.4.9 <4"]

describe("admits", () => {
	it.each([...Object.values(OPTIONAL_PEER_RANGES), ...OTHER_RANGES])("answers %s as semver does", (range) => {
		const answers = VERSIONS.map((version) => [version, admits(range, version)])
		expect(answers).toEqual(VERSIONS.map((version) => [version, semver.satisfies(version, range)]))
	})

	/* npm reads `<=1` as `<2.0.0-0` and `>1.2` as `>=1.3.0`: zero-filled, either would admit what npm does not */
	it.each(["<=1", ">1.2", "^1", "=1.2", "1"])("refuses %s, a partial bound npm reads otherwise", (range) => {
		expect(() => admits(range, "1.0.0")).toThrow(new TypeError(`comb reads no partial version in "${range}"`))
	})
})

describe("installedVersion", () => {
	const root = mkdtempSync(join(tmpdir(), "comb-peer-version-"))
	afterAll(() => rmSync(root, { force: true, recursive: true }))

	it("reads the version of the package.json up from the entry that names the peer, at a path or a file: URL", () => {
		const dir = join(root, "node_modules", "postgres")
		mkdirSync(join(dir, "src"), { recursive: true })
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "postgres", version: "3.4.9" }))
		writeFileSync(join(dir, "src", "package.json"), JSON.stringify({ type: "module" }))
		const entry = join(dir, "src", "index.js")
		expect(installedVersion("postgres", entry)).toBe("3.4.9")
		expect(installedVersion("postgres", pathToFileURL(entry).href)).toBe("3.4.9")
	})

	it("finds none where the peer's package.json names no version, or no package.json up from it names the peer", () => {
		const dir = join(root, "node_modules", "libpg-query")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "libpg-query", version: 17 }))
		expect(installedVersion("libpg-query", join(dir, "index.js"))).toBeUndefined()
		expect(installedVersion("wrangler", join(root, "index.js"))).toBeUndefined()
	})
})
