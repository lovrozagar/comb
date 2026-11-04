import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type D1Target, localD1Path, resolveBinding } from "./d1-binding.ts"

const file = (name: string) => join("/w", ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject", name)

/* M33 of the 0.13 review; tests/integration/d1 holds it to the wrangler comb pins */
describe("localD1Path", () => {
	it("names the file as Miniflare's idFromName does: the preview id, else the id, else the binding", () => {
		const id = "00000000-0000-0000-0000-000000000000"
		const at = file("9ba2b04bf514d9facfd57ed57d849e77241a7adc99d1c1545d06688b43d84248.sqlite")
		expect(localD1Path("/w", { binding: "CORE", database_id: id })).toBe(at)
		expect(localD1Path("/w", { binding: "CORE", database_id: "x", preview_database_id: id })).toBe(at)
		expect(localD1Path("/w", { binding: "C" })).toBe(
			file("edac2be004a4f4cc6b475e4b0e02d519ca9bf3d68ca97c0e8de3728dcfd3d80d.sqlite"),
		)
	})
})

/* D2-8 of the area D round-two review: wrangler's bare parse token named no file */
describe("resolveBinding: a wrangler config its reader fails on", () => {
	it("names the config, with what the reader threw as its cause", () => {
		const target = { name: "core", wranglerConfig: "/w/wrangler.jsonc" } as D1Target
		for (const thrown of [new Error("CloseBracketExpected"), "CloseBracketExpected"]) {
			const read = () => {
				throw thrown
			}
			let caught: unknown
			try {
				resolveBinding(read, target)
			} catch (error) {
				caught = error
			}
			expect(caught).toBeInstanceOf(Error)
			expect({ cause: (caught as Error).cause, message: (caught as Error).message }).toEqual({
				cause: thrown,
				message: "/w/wrangler.jsonc failed to load: CloseBracketExpected",
			})
		}
	})
})
