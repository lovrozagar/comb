/**
 * QL14 of r22b: the README's query-schema facts are the code's. It named two sizes for the largest
 * accepted query string, at most 14 KB and near 15 KB, where the code publishes 14336 bytes, and
 * left `limitBound` and `pageBound` out of the names `extend` may not take.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { RESERVED_LIST_KEYS } from "../../src/query/schema-params.ts"
import { MAX_QUERY_BYTES } from "../../src/query/schema-limits.ts"

const README = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../README.md"), "utf8")

describe("README's query-schema facts (QL14 of r22b; sibling: the error keys' list)", () => {
	it("names every reserved extend name the schema refuses, in order", () => {
		const list = /it may not take a name the schema owns \(([^)]*)\)/.exec(README)?.[1] ?? ""
		expect([...list.matchAll(/`([A-Za-z]+)`/g)].map((match) => match[1])).toEqual([...RESERVED_LIST_KEYS])
	})

	it("states one size for the largest accepted query string, the one maxQueryBytes publishes", () => {
		const sizes = [...README.matchAll(/largest accepted query string (?:is at most|stays near) (\d+) KB/g)]
		expect(sizes.map((match) => Number(match[1]) * 1024)).toEqual([MAX_QUERY_BYTES])
	})
})
