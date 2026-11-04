/**
 * KC5a of r22, its snapshot: each run lets its snapshot's hold go once it removed the copy, so a
 * signal that comes after it ends removes nothing of it again, and a long-lived host holds no step
 * per apply
 */
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeAtlas, revision, status } from "../../../tests/support/fake-atlas.ts"
import { noLive } from "../__fixtures__/live-objects.ts"
import { applyWithAtlas, type ApplyOptions, baselineWithAtlas, statusWithAtlas } from "./atlas-apply.ts"
import { sumHashes } from "./atlas-dir.ts"
import type { ObjectsCompare } from "./baseline-compare.ts"
import type { LiveRead } from "./pg-live-types.ts"
import type { Run } from "./process.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-apply-snapshot-"))
	writeFileSync(join(dir, "1_a.sql"), 'CREATE TABLE "a" ("id" int);\n')
	writeFileSync(join(dir, "atlas.sum"), "h1:x=\n1_a.sql h1:7=\n")
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** A database that holds nothing comb compares */
const readLive: LiveRead = async () => ({
	...noLive(),
	policies: new Map(),
	relations: new Map(),
	routines: new Map(),
	triggers: new Map(),
})

/** A run's options on `exec`, against a database that holds nothing comb compares */
function options(exec: Run): ApplyOptions & Pick<ObjectsCompare, "readLive" | "readReplay"> {
	return {
		approve: async () => ({ ok: true }),
		dir,
		exec,
		print: () => undefined,
		readLive,
		readReplay: async (target) => readLive(target),
		replayPending: async () => undefined,
		sweepDev: async () => undefined,
		target: { devUrl: "postgres://localhost/dev", lockTimeout: "5s", schema: "public", url: "postgres://app@db/app" },
	}
}

describe("a snapshot's hold, once the run that made it ends", () => {
	/* the worker's own SIGINT listeners, read as the file is collected, before any run holds a step */
	const worker = process.listeners("SIGINT")

	/** What SIGINT, with only comb's listener and process.kill stubbed, asks fs.rmSync to remove */
	async function removedBySignal(): Promise<string[]> {
		const others = worker
		for (const listener of others) process.off("SIGINT", listener)
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
		const rm = vi.spyOn(fs, "rmSync")
		try {
			process.emit("SIGINT", "SIGINT")
			await new Promise((resolve) => setImmediate(resolve))
			return rm.mock.calls
				.map(([target]) => String(target))
				.filter((target) => target.includes("comb-migrate-snapshot-"))
		} finally {
			rm.mockRestore()
			kill.mockRestore()
			for (const listener of others) process.on("SIGINT", listener)
		}
	}

	it.each<[string, (exec: Run) => Promise<unknown>]>([
		["apply", (exec: Run) => applyWithAtlas(options(exec))],
		["status", async (exec: Run) => statusWithAtlas(options(exec))],
		["baseline", (exec: Run) => baselineWithAtlas(options(exec))],
	])("is let go after %s, so a later signal removes nothing of it", async (_, body) => {
		const done = status({ applied: [revision("1", { hash: sumHashes(dir).get("1_a.sql") })], status: "OK" })
		await body(fakeAtlas({ status: done })).catch(() => undefined)
		expect(await removedBySignal()).toEqual([])
	})
})
