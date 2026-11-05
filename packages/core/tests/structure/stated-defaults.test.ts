/**
 * A doc that states an option's default ("60 when omitted") states the default the code fills in, so changing a
 * default without its doc fails here. Each case names an options interface in an entry's d.ts snapshot, the hover a
 * consumer reads, and the defaults object the code fills it from. Every key in that object needs a doc that states
 * it, and every doc in the interface that states a default needs a key there.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULTS as SHARD_ROUTER_DEFAULTS } from "../../src/sqlite/d1/sharding/config.ts"

const SNAPSHOTS = join(import.meta.dirname, "__snapshots__/api")

const CASES: ReadonlyArray<{ defaults: Readonly<Record<string, unknown>>; interface: string; snapshot: string }> = [
	{ defaults: SHARD_ROUTER_DEFAULTS, interface: "ShardRouterConfig", snapshot: "sqlite__d1__sharding.d.ts.txt" },
]

/* a stated default: a number, an optional parenthetical such as "(5 minutes)", then "when omitted" */
const STATED = /\b(\d+)(?: \([^)]*\))? when omitted\b/

/** Each member of `name`'s body in `dts`, by key, with the doc on it */
function memberDocs(dts: string, name: string): Map<string, string> {
	const start = dts.indexOf(`interface ${name} {`)
	expect(start, `interface ${name} in the snapshot`).toBeGreaterThan(-1)
	const body = dts.slice(start, dts.indexOf("\n}", start))
	const docs = new Map<string, string>()
	for (const [, doc, key] of body.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*(\w+)\??:/g))
		docs.set(key as string, doc as string)
	return docs
}

/** The default each doc in `docs` states, by key; a doc that states none is left out */
function statedDefaults(docs: ReadonlyMap<string, string>): Map<string, number> {
	const stated = new Map<string, number>()
	for (const [key, doc] of docs) {
		const match = STATED.exec(doc)
		if (match) stated.set(key, Number(match[1]))
	}
	return stated
}

describe("an option's doc states the default the code fills in", () => {
	for (const { defaults, interface: name, snapshot } of CASES) {
		it(`${name} states each of its defaults, and no other`, () => {
			const stated = statedDefaults(memberDocs(readFileSync(join(SNAPSHOTS, snapshot), "utf8"), name))
			expect(Object.fromEntries(stated)).toEqual({ ...defaults })
		})
	}

	it("reads a stated default with and without a parenthetical, and skips a doc that states none", () => {
		const docs = memberDocs(
			[
				"interface Opts {",
				"    /** a; 60 when omitted */",
				"    a?: number;",
				"    /** b; 900000 (15 minutes) when omitted */",
				"    b?: number;",
				"    /** c, required */",
				"    c: number;",
				"}",
			].join("\n"),
			"Opts",
		)
		expect(Object.fromEntries(statedDefaults(docs))).toEqual({ a: 60, b: 900_000 })
	})
})
