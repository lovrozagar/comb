/**
 * Records __snapshots__/peer-registry.json from the npm registry: for each of comb's peer ranges, every
 * version it admits and its floor's own peerDependencies, so tests/structure/peers.test.ts reads the
 * registry without the network: `bun tests/structure/support/write-peer-registry.ts`. Run it after any
 * peer range changes, and before a release, so a newly published version is in it.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import semver from "semver"

type Packument = { versions: Record<string, { peerDependencies?: Record<string, string> }> }

const { peerDependencies } = JSON.parse(readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8")) as {
	peerDependencies: Record<string, string>
}

const entries = await Promise.all(
	Object.entries(peerDependencies).map(async ([name, range]) => {
		const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`)
		if (!response.ok) throw new Error(`${name}: the registry answered ${response.status}`)
		const { versions } = (await response.json()) as Packument
		const admitted = Object.keys(versions)
			.filter((version) => semver.satisfies(version, range))
			.sort(semver.compare)
		const floor = semver.minVersion(range)?.version as string
		return [name, { admitted, floorPeers: versions[floor]?.peerDependencies ?? {}, range }] as const
	}),
)
const target = join(import.meta.dirname, "../__snapshots__/peer-registry.json")
writeFileSync(target, `${JSON.stringify(Object.fromEntries(entries), null, "\t")}\n`)
