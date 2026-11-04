/**
 * comb's optional peers, each with the range packages/core/package.json states for it
 * (tests/structure/peers.test.ts holds the two equal), and the one refusal comb gives when a
 * command needs a peer the project does not have (K7 of r20): the package, its range, why comb
 * needs it here, and an install that lands in range. A peer outside its range is refused as one
 * missing, naming the version found (K2 of r21). What each migrate command needs on each provider
 * (peer-needs.ts) the CLI resolves here before any connect, fetch, spawn or Atlas call (K1, P8, S2
 * of r21). A peer comb spawns is resolved from the
 * project, cwd up, and that one package is checked, read and run (K1 and K3 of r22): PATH never counts.
 * Atlas, which no package ships, is a row of the same table, its version read from `atlas version`
 * (PA5, KC6 and PA22 of r22), as is ts-morph for a SQLite diff whose comb.config.ts declares FTS (KC3).
 */
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { ATLAS, type BinNeed, type Command, type Need, needsOf, type Provider } from "./peer-needs.ts"
import { admits, installedVersion, manifestOf } from "./peer-version.ts"
import { ATLAS_INSTALL, ATLAS_RANGE, type BinPeer, type ProjectBin, type RunResult } from "./process.ts"

// lookup-table: each optional peer and the range comb is tested against
const OPTIONAL_PEER_RANGES = {
	"@libsql/client": ">=0.17.4 <0.18",
	"drizzle-kit": "1.0.0-rc.4 || 1.0.0-rc.5 || ^1.0.0",
	"libpg-query": ">=17.7.4 <18",
	postgres: ">=3.4.9 <4",
	"ts-morph": ">=28.0.0 <29",
	wrangler: ">=4.147.0 <5",
} as const

type OptionalPeer = keyof typeof OPTIONAL_PEER_RANGES

/** A peer comb needs: an npm package, or Atlas on PATH */
type Peer = OptionalPeer | "atlas"

// lookup-table: each peer and its range, Atlas's among them
const RANGES: Readonly<Record<Peer, string>> = { ...OPTIONAL_PEER_RANGES, atlas: ATLAS_RANGE }

/* the peers comb spawns rather than imports, each on the runtime 0.20.1 ran it on (the ruling of r22): wrangler's
   bin is a Node program that starts workerd, which comb under bun must not move onto bun; 0.20.1's `bun drizzle-kit`
   followed the bin's node shebang, so drizzle-kit runs on whatever runs comb, needing no other (AD5 of the area D review) */
// lookup-table: each optional peer comb spawns, and the runtime that runs its bin: node, or comb's own
const BIN_PEERS: Readonly<Record<BinPeer, "comb" | "node">> = { "drizzle-kit": "comb", wrangler: "node" }

/** The bin peers a command resolved, each the one package it checked and runs */
type Peers = { readonly [P in BinPeer]?: ProjectBin }

const isBinPeer = (peer: OptionalPeer): peer is BinPeer => Object.hasOwn(BIN_PEERS, peer)

/** A peer comb could not use: missing, or `found` at a version outside its range */
type Problem = { found?: string | undefined; peer: Peer; why: string }

/**
 * What comb says of the peers in `problems`: each, its range and why comb needs it, and one install
 * of them all, Atlas's by its install page
 */
function refusal(problems: readonly Problem[]): string {
	const needs = problems.map(({ found, peer, why }) => {
		const range = RANGES[peer]
		return `${peer} (${found === undefined ? range : `${range}, found ${found}`}) to ${why}`
	})
	/* quoted, so a shell passes each range whole: bun, npm and pnpm each install its newest admitted version */
	const npm = problems.flatMap(({ peer }) => (peer === "atlas" ? [] : [`"${peer}@${RANGES[peer]}"`]))
	const atlas = problems.some(({ peer }) => peer === "atlas") ? [`atlas from ${ATLAS_INSTALL}`] : []
	return `comb needs ${needs.join(", and ")}; install ${[npm.join(" "), ...atlas].filter((part) => part !== "").join(", and ")}`
}

/** What comb says when the peer `need` names is missing */
const missingPeer = (need: Need): string => refusal([need])

/** A peer comb needed and did not find, or found outside its range; its message is the whole report */
class MissingPeerError extends Error {
	override name = "MissingPeerError"
}

/* `peer` itself did not resolve, as Node and Bun word it, or as a loader that wraps the resolver's error (vitest's,
   vite-node's) passes it on as the cause; a module that loaded and failed inside is no missing peer. Bun 1.3 throws
   the resolver's error as a ResolveMessage that is no Error, so any object's message counts */
function isMissing(error: unknown, peer: string): boolean {
	if (typeof error !== "object" || error === null) return false
	const { cause, message } = error as { cause?: unknown; message?: unknown }
	const said = [`Cannot find package '${peer}'`, `Cannot find module '${peer}'`]
	return (typeof message === "string" && said.some((text) => message.includes(text))) || isMissing(cause, peer)
}

/* the failure of loading `peer`, as comb reports it: the refusal for a missing peer, any other as it is */
function refusalOf(error: unknown, need: Need): unknown {
	return isMissing(error, need.peer) ? new MissingPeerError(refusal([need]), { cause: error }) : error
}

/** The problem with `peer` at `entry`, a version outside its range; undefined when it is in range */
function outOfRange(need: Need, entry: string): Problem | undefined {
	const found = installedVersion(need.peer, entry)
	if (found !== undefined && admits(RANGES[need.peer], found)) return undefined
	return { ...need, found: found ?? "no version" }
}

/** Throws the refusal of `peer` at `entry` when its version is outside its range */
function refuseOutOfRange(need: Need, entry: string): void {
	const problem = outOfRange(need, entry)
	if (problem !== undefined) throw new MissingPeerError(refusal([problem]))
}

/** The entry of `peer` as comb's own imports resolve it */
const resolved = (peer: OptionalPeer): string => import.meta.resolve(peer)

/**
 * What `load` loads: `peer`, or a module of comb's that imports it, once `locate` (the peer's
 * entry, as comb resolves it) shows it in range. A missing `peer` throws a MissingPeerError
 * naming it, its range and the install, as does one outside its range; any other failure passes
 * on as it is.
 */
async function optionalPeer<T>(
	need: Need,
	load: () => Promise<T>,
	locate: () => string = () => resolved(need.peer),
): Promise<T> {
	try {
		refuseOutOfRange(need, locate())
		return await load()
	} catch (error) {
		throw refusalOf(error, need)
	}
}

/** `resolve()`, which resolves `peer` without loading it, for a process that loads it later; refused as optionalPeer refuses */
function resolvePeer(need: Need, resolve: () => string): string {
	let entry: string
	try {
		entry = resolve()
	} catch (error) {
		throw refusalOf(error, need)
	}
	refuseOutOfRange(need, entry)
	return entry
}

/**
 * The problem with the Atlas `read` finds, which reads `atlas version`: missing from PATH, saying
 * no version, or one outside ATLAS_RANGE; undefined when it is in range. An official build and a
 * community one say the version alike, after "version v". One that exits otherwise, as a version
 * manager's shim with no version set does, keeps its code and the first line it said on stderr
 * (AD11 of the area D review).
 */
function atlasProblem(read: () => RunResult): Problem | undefined {
	const said = read()
	if (said.code === 127) return ATLAS
	if (said.code !== 0) {
		const first = said.stderr.split("\n").find((line) => line.trim() !== "")
		const why = first === undefined ? "" : `: ${first.trim()}`
		return { ...ATLAS, found: `no version, as atlas version exited ${said.code}${why}` }
	}
	const found = /\bversion v(\d+\.\d+\.\d+)/.exec(said.stdout)?.[1]
	if (found !== undefined && admits(ATLAS_RANGE, found)) return undefined
	return { ...ATLAS, found: found ?? "no version" }
}

/** `peer`'s package.json in the project at `cwd`: the first node_modules from its folder up that holds it */
function inProject(peer: OptionalPeer, cwd: string): string {
	for (let dir = cwd; ; dir = dirname(dir)) {
		const file = join(dir, "node_modules", peer, "package.json")
		if (existsSync(file)) return file
		if (dirname(dir) === dir) throw new Error(`Cannot find package '${peer}' from ${cwd}`)
	}
}

/** The bin peer whose file `entry` is, as comb spawns it: the bin its package.json names for it, on its runtime */
function binAt(peer: BinPeer, entry: string): ProjectBin {
	const manifest = manifestOf(peer, entry) as string
	const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: unknown }
	/* a string bin is the package's one bin, named as the package (manifestOf found it by that name) */
	const path = typeof bin === "string" ? bin : (bin as Record<string, unknown> | undefined)?.[peer]
	if (typeof path !== "string") throw new Error(`${manifest} names no ${peer} bin`)
	const runtime = BIN_PEERS[peer] === "comb" ? process.execPath : "node"
	return { bin: join(dirname(manifest), path), manifest, peer, runtime }
}

/** The bin `need` names in the project at `cwd`, from its folder up; refused as requirePeers refuses it */
function projectBin(need: BinNeed, cwd: string): ProjectBin {
	return binAt(
		need.peer,
		resolvePeer(need, () => inProject(need.peer, cwd)),
	)
}

/** Where requirePeers looks: `atlas` reads `atlas version`, `locate` finds an npm peer's entry, `fts` says a SQLite diff declares FTS */
type Finders = {
	atlas: () => RunResult
	cwd: string
	fts?: boolean | undefined
	locate?: ((peer: OptionalPeer) => string) | undefined
}

/**
 * Refuses `command` on `provider` unless each peer it needs is there and in range, naming every
 * one that is not in one refusal, with one install, and gives each bin peer it found. `locate`
 * finds a peer's entry: by default a bin peer in the project from `cwd` up, any other as comb's
 * own imports resolve it. Atlas is read once, by `atlas`, where the command runs it.
 */
function requirePeers(command: Command, provider: Provider, { atlas, cwd, fts = false, locate }: Finders): Peers {
	const find = locate ?? ((peer) => (isBinPeer(peer) ? inProject(peer, cwd) : resolved(peer)))
	const problems: Problem[] = []
	const peers: { [P in BinPeer]?: ProjectBin } = {}
	let cause: unknown
	for (const need of needsOf(command, provider, fts)) {
		if (need.peer === "atlas") {
			const problem = atlasProblem(atlas)
			if (problem !== undefined) problems.push(problem)
			continue
		}
		if (need.optional === true) continue
		const peer = need.peer
		try {
			const entry = find(peer)
			const problem = outOfRange(need, entry)
			if (problem !== undefined) problems.push(problem)
			else if (isBinPeer(peer)) peers[peer] = binAt(peer, entry)
		} catch (error) {
			if (!isMissing(error, peer)) throw error
			// reason: a missing peer is one more the refusal after the loop names, with the first one's error as its cause
			cause ??= error
			problems.push(need)
		}
	}
	if (problems.length > 0) throw new MissingPeerError(refusal(problems), { cause })
	return peers
}

/** The bin requirePeers resolved for `peer`, for a command whose row needs it */
function binOf(peers: Peers, peer: BinPeer): ProjectBin {
	const bin = peers[peer]
	if (bin === undefined) throw new Error(`comb resolved no ${peer} for this command`)
	return bin
}

/** The entry module of the package `bin` is from: the one package comb checked and spawns */
const binEntry = (bin: ProjectBin): string => createRequire(bin.manifest).resolve(dirname(bin.manifest))

/** The module of the package `bin` is from, by its entry */
async function importBin<T>(bin: ProjectBin): Promise<T> {
	return (await import(pathToFileURL(binEntry(bin)).href)) as T
}

export {
	binEntry,
	binOf,
	importBin,
	MissingPeerError,
	missingPeer,
	OPTIONAL_PEER_RANGES,
	type OptionalPeer,
	optionalPeer,
	type Peer,
	type Peers,
	projectBin,
	requirePeers,
	resolvePeer,
}
