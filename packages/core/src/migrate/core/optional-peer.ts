/**
 * comb's optional peers, each with the range packages/core/package.json states for it
 * (tests/structure/peers.test.ts holds the two equal), and the one refusal comb gives when a
 * command needs a peer the project does not have (K7 of r20): the package, its range, why comb
 * needs it here, and an install that lands in range. A peer outside its range is refused as one
 * missing, naming the version found (K2 of r21). PEERS is what each migrate command needs on each
 * provider, which the CLI resolves before any connect, fetch, spawn or Atlas call (K1, P8, S2 of
 * r21), and which the README's peer table states (K5). A peer comb spawns is resolved from the
 * project, cwd up, and that one package is checked, read and run (K1 and K3 of r22): PATH never counts.
 */
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ProviderConfig } from "../types.ts"
import { admits, installedVersion, manifestOf } from "./peer-version.ts"
import type { BinPeer, ProjectBin } from "./process.ts"

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

/* the peers comb spawns rather than imports, each on the runtime the ruling of r22 keeps for it: wrangler's bin is
   a Node program that starts workerd, which comb under bun must not move onto bun */
// lookup-table: each optional peer comb spawns, and the runtime that runs its bin
const BIN_PEERS: Readonly<Record<BinPeer, ProjectBin["runtime"]>> = { "drizzle-kit": "bun", wrangler: "node" }

/** The bin peers a command resolved, each the one package it checked and runs */
type Peers = { readonly [P in BinPeer]?: ProjectBin }

const isBinPeer = (peer: OptionalPeer): peer is BinPeer => Object.hasOwn(BIN_PEERS, peer)

/** A peer comb needs, and why; an `optional` one a command runs without, saying what it left out */
type Need = { optional?: true; peer: OptionalPeer; why: string }

/** A peer comb could not use: missing, or `found` at a version outside its range */
type Problem = { found?: string | undefined; peer: OptionalPeer; why: string }

/** What comb says of the peers in `problems`: each, its range and why comb needs it, and one install of them all */
function refusal(problems: readonly Problem[]): string {
	const needs = problems.map(({ found, peer, why }) => {
		const range = OPTIONAL_PEER_RANGES[peer]
		return `${peer} (${found === undefined ? range : `${range}, found ${found}`}) to ${why}`
	})
	/* quoted, so a shell passes each range whole: bun, npm and pnpm each install its newest admitted version */
	const install = problems.map(({ peer }) => `"${peer}@${OPTIONAL_PEER_RANGES[peer]}"`).join(" ")
	return `comb needs ${needs.join(", and ")}; install ${install}`
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
	if (found !== undefined && admits(OPTIONAL_PEER_RANGES[need.peer], found)) return undefined
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

/* ── what each command needs ───────────────────────────────────────────── */

type Command = "apply" | "baseline" | "check" | "diff" | "status"
type Provider = ProviderConfig["type"]

/** What a bin peer is needed for */
type BinNeed = Need & { peer: BinPeer }

const DIFF: BinNeed = { peer: "drizzle-kit", why: "export the drizzle schema for comb migrate diff" }
const LIBSQL: Need = { peer: "@libsql/client", why: "open a libsql or Turso database" }
const PARSE: Need = { peer: "libpg-query", why: "read Postgres migrations" }
const WRANGLER: BinNeed = { peer: "wrangler", why: "migrate a D1 database" }

/** The peers of a provider whose every command but diff connects through `need` */
const connecting = (need: Need): Partial<Record<Command, readonly Need[]>> => ({
	apply: [need],
	baseline: [need],
	check: [need],
	diff: [DIFF],
	status: [need],
})

// lookup-table: the peers each migrate command needs on each provider, before its first I/O
const PEERS: Readonly<Record<Provider, Partial<Record<Command, readonly Need[]>>>> = {
	"bun-sqlite": { diff: [DIFF] },
	d1: /* @__PURE__ */ connecting(WRANGLER),
	libsql: /* @__PURE__ */ connecting(LIBSQL),
	postgres: {
		apply: [
			PARSE,
			/* without it apply sweeps nothing a killed check left on devUrl's server (pg-replay-database.ts) */
			{ optional: true, peer: "postgres", why: "sweep what a killed check left on a postgres:// devUrl's server" },
		],
		baseline: [PARSE, { peer: "postgres", why: "read what Atlas OSS leaves out of a baseline's compare" }],
		check: [
			PARSE,
			/* without it check rates the files alone, and says it did not replay them (pg-check-replay.ts) */
			{ optional: true, peer: "postgres", why: "replay the history and the pending files on a postgres:// devUrl" },
		],
		diff: [PARSE, DIFF],
	},
	turso: /* @__PURE__ */ connecting(LIBSQL),
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
	return { bin: join(dirname(manifest), path), manifest, peer, runtime: BIN_PEERS[peer] }
}

/** The bin `need` names in the project at `cwd`, from its folder up; refused as requirePeers refuses it */
function projectBin(need: BinNeed, cwd: string): ProjectBin {
	return binAt(
		need.peer,
		resolvePeer(need, () => inProject(need.peer, cwd)),
	)
}

/**
 * Refuses `command` on `provider` unless each peer it needs is there and in range, naming every
 * one that is not in one refusal, with one install, and gives each bin peer it found. `locate`
 * finds a peer's entry: by default a bin peer in the project from `cwd` up, any other as comb's
 * own imports resolve it.
 */
function requirePeers(
	command: Command,
	provider: Provider,
	{ cwd, locate }: { cwd: string; locate?: ((peer: OptionalPeer) => string) | undefined },
): Peers {
	const find = locate ?? ((peer) => (isBinPeer(peer) ? inProject(peer, cwd) : resolved(peer)))
	const problems: Problem[] = []
	const peers: { [P in BinPeer]?: ProjectBin } = {}
	let cause: unknown
	for (const need of PEERS[provider][command] ?? []) {
		if (need.optional === true) continue
		try {
			const entry = find(need.peer)
			const problem = outOfRange(need, entry)
			if (problem !== undefined) problems.push(problem)
			else if (isBinPeer(need.peer)) peers[need.peer] = binAt(need.peer, entry)
		} catch (error) {
			if (!isMissing(error, need.peer)) throw error
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

/** The module of the package `bin` is from, by its entry: the one package comb checked and spawns */
async function importBin<T>(bin: ProjectBin): Promise<T> {
	const entry = createRequire(bin.manifest).resolve(dirname(bin.manifest))
	return (await import(pathToFileURL(entry).href)) as T
}

export {
	binOf,
	type Command,
	DIFF,
	importBin,
	LIBSQL,
	MissingPeerError,
	missingPeer,
	type Need,
	OPTIONAL_PEER_RANGES,
	type OptionalPeer,
	optionalPeer,
	PARSE,
	type Peers,
	PEERS,
	projectBin,
	requirePeers,
	resolvePeer,
	WRANGLER,
}
