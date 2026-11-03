import { readFileSync } from "node:fs"
import { join } from "node:path"
import semver from "semver"
import { describe, expect, it } from "vitest"
import { admittedOf, floorOf, TOOLS, toolsFor } from "../consumers/stage.ts"

type Recorded = { floorPeers: Record<string, string>; newestPeers: Record<string, string>; range: string }
const REGISTRY = JSON.parse(readFileSync(join(import.meta.dirname, "__snapshots__/peer-registry.json"), "utf8")) as {
	wrangler: Recorded
}

const TYPES = "@cloudflare/workers-types"
const newest = admittedOf("wrangler").at(-1) as string
const floor = floorOf(REGISTRY.wrangler.range)

/* the consumer stage installs the newest wrangler comb admits beside the tools; npm refuses a workers-types outside its peer range (ERESOLVE) */
describe("the consumer stage's tools", () => {
	it("install a workers-types the newest wrangler's peer range admits", () => {
		const range = REGISTRY.wrangler.newestPeers[TYPES] as string
		const picked = toolsFor({ wrangler: newest })[TYPES] as string
		expect({ picked, satisfies: semver.satisfies(picked, range) }).toEqual({ picked, satisfies: true })
	})

	it("keep the catalog's workers-types where the wrangler admits it, as the floor's does", () => {
		expect(semver.satisfies(TOOLS[TYPES], REGISTRY.wrangler.floorPeers[TYPES] as string)).toBe(true)
		expect(toolsFor({ wrangler: floor })[TYPES]).toBe(TOOLS[TYPES])
		/* a stage of required peers installs wrangler as a tool, at the catalog's version */
		expect(toolsFor({})[TYPES]).toBe(TOOLS[TYPES])
	})

	it("install the workers-types a pin names", () => {
		expect(toolsFor({ wrangler: newest }, { [TYPES]: "5.20261101.1" })[TYPES]).toBe("5.20261101.1")
	})

	it("refuse a wrangler whose peers the registry never recorded", () => {
		const between = admittedOf("wrangler").find((version) => version !== newest && version !== floor) as string
		expect(() => toolsFor({ wrangler: between })).toThrow(
			`the recorded registry holds no peers of wrangler@${between}: rerun support/write-peer-registry.ts`,
		)
	})
})
