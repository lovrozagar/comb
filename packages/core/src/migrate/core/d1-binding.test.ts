import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { localD1Path } from "./d1-binding.ts"

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
