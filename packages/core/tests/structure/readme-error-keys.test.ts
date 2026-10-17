/** The README's list of built-in error keys is the list combErrorKeys holds, no more and no fewer. */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { combErrorKeys } from "../../src/types.ts"

const README = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../README.md"), "utf8")

describe("README error keys", () => {
	it("names every combErrorKeys entry, in order", () => {
		const line = README.split("\n").find((text) => text.startsWith("Built-in keys (`combErrorKeys`):")) ?? ""
		const listed = [...line.matchAll(/`([A-Z_]+)`/g)].map((match) => match[1])
		expect(listed).toEqual(Object.keys(combErrorKeys))
	})
})
