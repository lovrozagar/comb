import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { version } from "./version.ts"

describe("version", () => {
	it("is comb's package.json version", () => {
		const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")) as {
			version: string
		}
		expect(version()).toBe(manifest.version)
	})

	/* D5-5 of the area D round-five review: a compiled executable read /package.json and failed with ENOENT */
	it("refuses the version in a Bun single-file executable, saying why, before it reads a file", () => {
		expect(() => version("file:///$bunfs/root/app-exe")).toThrow(
			new Error(
				"comb --version reads comb's package.json from disk, which a Bun single-file executable does not hold: run comb with bun or node",
			),
		)
	})
})
