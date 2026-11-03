/**
 * What each migrate command needs on each provider, before its first I/O: the npm peers and Atlas,
 * which optional-peer.ts's requirePeers checks in one refusal, and which the README's peer table
 * states (K5 of r21). Atlas is a row like any peer (PA5, KC6 and PA22 of r22), and a SQLite diff
 * whose comb.config.ts declares FTS needs ts-morph as well (KC3).
 */
import type { ProviderConfig } from "../types.ts"
import type { OptionalPeer } from "./optional-peer.ts"
import type { BinPeer } from "./process.ts"

/** An npm peer comb needs, and why; an `optional` one a command runs without, saying what it left out */
type Need = { optional?: true | undefined; peer: OptionalPeer; why: string }

/** Atlas, as a command needs it: never optional */
type AtlasNeed = { optional?: undefined; peer: "atlas"; why: string }

/** What a command needs: an npm peer or Atlas */
type Requirement = AtlasNeed | Need

type Command = "apply" | "baseline" | "check" | "diff" | "status"
type Provider = ProviderConfig["type"]

/** What a bin peer is needed for */
type BinNeed = Need & { peer: BinPeer }

const ATLAS: AtlasNeed = { peer: "atlas", why: "hash, diff and apply migrations" }
const DIFF: BinNeed = { peer: "drizzle-kit", why: "export the drizzle schema for comb migrate diff" }
/* the FTS part of a SQLite diff is built from the tables file, whose imports ts-morph resolves (codegen/runtime/load.ts) */
const FTS: Need = { peer: "ts-morph", why: "read the tables file whose FTS comb.config.ts declares" }
const LIBSQL: Need = { peer: "@libsql/client", why: "open a libsql or Turso database" }
const PARSE: Need = { peer: "libpg-query", why: "read Postgres migrations" }
const WRANGLER: BinNeed = { peer: "wrangler", why: "migrate a D1 database" }

/**
 * The peers of a SQLite-family provider whose commands connect through `need`: Atlas hashes the
 * directory check and apply run (plan-apply.ts) and the history baseline compares (baseline-compare.ts)
 */
const connecting = (need: Need): Partial<Record<Command, readonly Requirement[]>> => ({
	apply: [need, ATLAS],
	baseline: [need, ATLAS],
	check: [need, ATLAS],
	diff: [DIFF, ATLAS],
	status: [need],
})

// lookup-table: the peers each migrate command needs on each provider, before its first I/O
const PEERS: Readonly<Record<Provider, Partial<Record<Command, readonly Requirement[]>>>> = {
	"bun-sqlite": { apply: [ATLAS], baseline: [ATLAS], check: [ATLAS], diff: [DIFF, ATLAS] },
	/* a D1 baseline records through wrangler alone, and runs no Atlas */
	d1: { .../* @__PURE__ */ connecting(WRANGLER), baseline: [WRANGLER] },
	libsql: /* @__PURE__ */ connecting(LIBSQL),
	/* every Postgres command runs through Atlas, status included */
	postgres: {
		apply: [
			PARSE,
			ATLAS,
			/* without it apply sweeps nothing a killed check left on devUrl's server (pg-replay-database.ts) */
			{ optional: true, peer: "postgres", why: "sweep what a killed check left on a postgres:// devUrl's server" },
		],
		baseline: [PARSE, { peer: "postgres", why: "read what Atlas OSS leaves out of a baseline's compare" }, ATLAS],
		check: [
			PARSE,
			ATLAS,
			/* without it check rates the files alone, and says it did not replay them (pg-check-replay.ts) */
			{ optional: true, peer: "postgres", why: "replay the history and the pending files on a postgres:// devUrl" },
		],
		diff: [PARSE, DIFF, ATLAS],
		status: [ATLAS],
	},
	turso: /* @__PURE__ */ connecting(LIBSQL),
}

/** What `command` on `provider` needs: its row, with ts-morph after drizzle-kit on a SQLite diff that declares FTS */
function needsOf(command: Command, provider: Provider, fts: boolean): readonly Requirement[] {
	const row = PEERS[provider][command] ?? []
	if (!fts || command !== "diff" || provider === "postgres") return row
	return row.flatMap((need) => (need === DIFF ? [DIFF, FTS] : [need]))
}

export {
	ATLAS,
	type AtlasNeed,
	type BinNeed,
	type Command,
	DIFF,
	FTS,
	LIBSQL,
	type Need,
	needsOf,
	PARSE,
	PEERS,
	type Provider,
	type Requirement,
	WRANGLER,
}
