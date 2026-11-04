import { describe, expect, it } from "vitest"
import { refuseCompiled } from "./compiled.ts"

/* D3-4 and D4-5 of the area D reviews: in a Bun single-file executable, process.execPath is the app and comb's modules live in its embedded filesystem */
describe("refuseCompiled", () => {
	it("refuses a module a Bun single-file executable embeds, on posix and on windows, and passes one on disk", () => {
		expect(() => refuseCompiled("file:///$bunfs/root/app-exe", "no child here")).toThrow(new Error("no child here"))
		expect(() => refuseCompiled("file:///B:/~BUN/root/app-exe.exe", "no child here")).toThrow(
			new Error("no child here"),
		)
		expect(refuseCompiled(import.meta.url, "no child here")).toBeUndefined()
	})
})
