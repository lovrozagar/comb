/// <reference types="bun-types" />
/**
 * SD1 of r22: check proves a D1 file on the checked wrangler's Miniflare, which runs on node as wrangler's own
 * apply runs it. Under bun, comb starts the proof as a node child through process.ts, never in its own process.
 */
import { describe, expect, it } from "bun:test"
import { proveOnD1 } from "../../src/migrate/core/d1-engine.ts"
import { projectBin } from "../../src/migrate/core/optional-peer.ts"
import { WRANGLER } from "../../src/migrate/core/peer-needs.ts"
import { type Run, run } from "../../src/migrate/core/process.ts"
import type { LiveObject } from "../../src/migrate/core/proof-copy.ts"

const LIVE: LiveObject[] = [
	{ name: "t", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, v REAL)", table: "t", type: "table" },
]

describe("proveOnD1 under bun (SD1 of r22)", () => {
	it("runs the proof on node, the runtime wrangler runs on, and passes a file D1 runs", async () => {
		const runtimes: string[] = []
		const exec: Run = (cmd, args, options) => {
			runtimes.push(cmd)
			return run(cmd, args, options)
		}
		const bin = projectBin(WRANGLER, import.meta.dirname)
		const files = [{ name: "1_a.sql", sql: "CREATE TABLE a (x);" }]
		await proveOnD1(LIVE, files, { bin, exec, table: "d1_migrations" })
		expect(runtimes).toEqual(["node"])
	}, 120_000)
})
