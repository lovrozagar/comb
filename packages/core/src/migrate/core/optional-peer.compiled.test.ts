/**
 * D5-2 of the area D round-five review: inside a Bun single-file executable an installed peer comb
 * loads from the project read as missing, with an install hint for a package that was there. Each
 * such load is refused up front with the reason, naming the peer; a peer comb only spawns is not.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { optionalPeer, requirePeers } from "./optional-peer.ts"
import type { RunResult } from "./process.ts"

/* where a compiled executable embeds comb's modules */
const EMBEDDED = "file:///$bunfs/root/app-exe"

const ROOT = mkdtempSync(join(tmpdir(), "comb-optional-peer-compiled-"))
afterAll(() => rmSync(ROOT, { force: true, recursive: true }))

/** What comb says of `peers` in a compiled executable */
const refused = (peers: string): Error =>
	new Error(
		`comb loads ${peers} from the project, which a Bun single-file executable cannot do: run it with bun or node, not from a compiled executable`,
	)

/** The Atlas comb is tested against, counting each read of its version */
function atlasReads(): { atlas: () => Promise<RunResult>; reads: () => number } {
	let reads = 0
	const atlas = async (): Promise<RunResult> => {
		reads += 1
		return { code: 0, stderr: "", stdout: "atlas version v1.3.0\n" }
	}
	return { atlas, reads: () => reads }
}

/** A locator that must not run: a compiled executable is refused before any peer is found */
const unreached = (): never => {
	throw new Error("located a peer")
}

describe("in a Bun single-file executable, a peer comb loads from the project", () => {
	it("is refused by optionalPeer before it locates or loads, naming the peer", async () => {
		let loads = 0
		const load = async () => {
			loads += 1
		}
		const loading = optionalPeer({ peer: "@libsql/client", why: "open" }, load, {
			locate: unreached,
			moduleUrl: EMBEDDED,
		})
		await expect(loading).rejects.toThrow(refused("@libsql/client"))
		expect(loads).toBe(0)
	})

	it("is refused by requirePeers before Atlas is read, naming every one the command loads", async () => {
		const { atlas, reads } = atlasReads()
		const finders = { atlas, cwd: ROOT, locate: unreached, moduleUrl: EMBEDDED }
		await expect(requirePeers("check", "libsql", finders)).rejects.toThrow(refused("@libsql/client"))
		await expect(requirePeers("apply", "turso", finders)).rejects.toThrow(refused("@libsql/client"))
		await expect(requirePeers("baseline", "postgres", finders)).rejects.toThrow(refused("libpg-query and postgres"))
		await expect(requirePeers("diff", "postgres", finders)).rejects.toThrow(refused("libpg-query"))
		/* D6-3 of the area D round-six review: an optional peer, postgres on a check, is one comb runs without, so it goes unnamed */
		await expect(requirePeers("check", "postgres", finders)).rejects.toThrow(refused("libpg-query"))
		/* D6-2 of the area D round-six review: the FTS tables file loads in a child process, as codegen loads it */
		await expect(requirePeers("diff", "libsql", { ...finders, fts: true })).rejects.toThrow(
			new Error(
				"comb migrate diff loads the tables file in a child process, which cannot read the modules a Bun single-file executable embeds: run comb migrate with bun or node, not from a compiled executable",
			),
		)
		expect(reads()).toBe(0)
	})

	it("leaves a command whose peers comb only spawns, or that loads none", async () => {
		const kit = join(ROOT, "d1", "node_modules", "drizzle-kit")
		mkdirSync(kit, { recursive: true })
		writeFileSync(
			join(kit, "package.json"),
			JSON.stringify({ bin: "bin.cjs", name: "drizzle-kit", version: "1.0.0-rc.5" }),
		)
		const { atlas } = atlasReads()
		const found = await requirePeers("diff", "d1", { atlas, cwd: join(ROOT, "d1"), moduleUrl: EMBEDDED })
		expect(found["drizzle-kit"]?.manifest).toBe(join(kit, "package.json"))
		/* Postgres's status runs Atlas alone; its optional replay peer on check is never loaded up front */
		await expect(requirePeers("status", "postgres", { atlas, cwd: ROOT, moduleUrl: EMBEDDED })).resolves.toEqual({})
	})
})
