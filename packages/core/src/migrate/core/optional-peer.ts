/**
 * comb's optional peers, each with the range packages/core/package.json states for it
 * (tests/structure/peers.test.ts holds the two equal), and the one refusal comb gives when a
 * command needs a peer the project does not have (K7 of r20): the package, its range, why comb
 * needs it here, and the install.
 */

// lookup-table: each optional peer and the range comb is tested against
const OPTIONAL_PEER_RANGES = {
	"@cloudflare/workers-types": ">=5.20261001.1 <6",
	"@libsql/client": ">=0.17.4 <0.18",
	"drizzle-kit": "1.0.0-rc.4 || 1.0.0-rc.5 || ^1.0.0",
	"libpg-query": ">=17.7.4 <18",
	postgres: ">=3.4.9 <4",
	"ts-morph": ">=28.0.0 <29",
	wrangler: ">=4.147.0 <5",
} as const

type OptionalPeer = keyof typeof OPTIONAL_PEER_RANGES

/* the peers comb runs as a command: a global comb finds them only on a project's PATH */
// lookup-table: the optional peers comb spawns rather than imports
const BINS: ReadonlySet<OptionalPeer> = /* @__PURE__ */ new Set<OptionalPeer>(["drizzle-kit", "wrangler"])

/** What comb says when `peer`, which it needs to `why`, is missing */
function missingPeer(peer: OptionalPeer, why: string): string {
	const path = BINS.has(peer) ? "run comb through a package script, so node_modules/.bin is on PATH, or " : ""
	return `comb needs ${peer} (${OPTIONAL_PEER_RANGES[peer]}) to ${why}; ${path}install ${peer}`
}

/** A peer comb needed and did not find; its message is the whole report */
class MissingPeerError extends Error {
	override name = "MissingPeerError"
}

/* `peer` itself did not resolve, as Node and Bun word it, or as a loader that wraps the resolver's error (vitest's,
   vite-node's) passes it on as the cause; a module that loaded and failed inside is no missing peer */
const isMissing = (error: unknown, peer: string): boolean =>
	error instanceof Error &&
	([`Cannot find package '${peer}'`, `Cannot find module '${peer}'`].some((said) => error.message.includes(said)) ||
		isMissing(error.cause, peer))

/* the failure of loading `peer`, as comb reports it: the refusal for a missing peer, any other as it is */
function refusalOf(error: unknown, peer: OptionalPeer, why: string): unknown {
	return isMissing(error, peer) ? new MissingPeerError(missingPeer(peer, why), { cause: error }) : error
}

/**
 * What `load` loads: `peer`, or a module of comb's that imports it. A missing `peer` throws a
 * MissingPeerError naming it, its range and the install; any other failure passes on as it is.
 */
async function optionalPeer<T>(peer: OptionalPeer, why: string, load: () => Promise<T>): Promise<T> {
	try {
		return await load()
	} catch (error) {
		throw refusalOf(error, peer, why)
	}
}

/** `resolve()`, which resolves `peer` without loading it, for a process that loads it later; refused as optionalPeer refuses */
function resolvePeer(peer: OptionalPeer, why: string, resolve: () => string): string {
	try {
		return resolve()
	} catch (error) {
		throw refusalOf(error, peer, why)
	}
}

export { MissingPeerError, missingPeer, OPTIONAL_PEER_RANGES, type OptionalPeer, optionalPeer, resolvePeer }
