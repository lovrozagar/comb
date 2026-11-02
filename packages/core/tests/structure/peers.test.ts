/**
 * K3, K4 and K8 of r20: what an install of comb's peers resolves. Each range admits only tagged
 * releases (drizzle publishes a `1.0.0-rc.N-<hash>` build of every branch, which semver ranks above
 * the tagged rc), each floor's own peers are met by comb's other floors, so npm installs them
 * together, and the README's install lines pin drizzle inside the range, as `latest` is outside it.
 * The registry is read from __snapshots__/peer-registry.json, recorded by
 * support/write-peer-registry.ts.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import semver from "semver"
import { describe, expect, it } from "vitest"

const CORE = join(import.meta.dirname, "../..")
const { peerDependencies } = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as {
	peerDependencies: Record<string, string>
}
const { catalog } = (
	JSON.parse(readFileSync(join(CORE, "../../package.json"), "utf8")) as {
		workspaces: { catalog: Record<string, string> }
	}
).workspaces
const REGISTRY = JSON.parse(
	readFileSync(join(import.meta.dirname, "__snapshots__/peer-registry.json"), "utf8"),
) as Record<string, { admitted: string[]; floorPeers: Record<string, string>; range: string }>
const README = readFileSync(join(CORE, "../../README.md"), "utf8")

/* a build of a branch's commit, as drizzle publishes one: a prerelease ending in the commit's hash */
const isCommitBuild = (version: string): boolean => /-[0-9a-f]{7,40}$/.test(version)

/** The floor of comb's range for `name` */
const floorOf = (name: string): string => semver.minVersion(peerDependencies[name] as string)?.version as string

describe("comb's peer ranges, against the registry", () => {
	it("are the ranges the registry was recorded for: rerun support/write-peer-registry.ts after a change", () => {
		expect(Object.fromEntries(Object.entries(REGISTRY).map(([name, { range }]) => [name, range]))).toEqual(
			peerDependencies,
		)
	})

	it("each admit no commit build", () => {
		const builds = Object.entries(REGISTRY).flatMap(([name, { admitted }]) =>
			admitted.filter(isCommitBuild).map((version) => `${name}@${version}`),
		)
		expect(builds).toEqual([])
	})

	it("have floors that install together: each floor's peers among comb's are met by comb's floor of them", () => {
		const unmet = Object.entries(REGISTRY).flatMap(([name, { floorPeers }]) =>
			Object.entries(floorPeers)
				.filter(([peer]) => peer in peerDependencies)
				.filter(([peer, range]) => !semver.satisfies(floorOf(peer), range))
				.map(([peer, range]) => `${name}@${floorOf(name)} needs ${peer} ${range}, comb's floor is ${floorOf(peer)}`),
		)
		expect(unmet).toEqual([])
	})
})

describe("the README's install lines", () => {
	const lines = README.split("\n").filter((line) => /^(?:bun add|npm install|pnpm add) /.test(line))

	it("pin drizzle at the version comb's suites run, inside the peer range", () => {
		expect(lines).toHaveLength(3)
		for (const line of lines) {
			const pin = /(?:^| )drizzle-orm(?:@(\S+))?(?: |$)/.exec(line)?.[1]
			expect(pin, line).toBe(catalog["drizzle-orm"])
			expect(semver.satisfies(pin as string, peerDependencies["drizzle-orm"] as string), line).toBe(true)
		}
	})
})
