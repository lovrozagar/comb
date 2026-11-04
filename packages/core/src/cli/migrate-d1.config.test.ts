import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { fakeD1, writeSum } from "./__fixtures__/d1.ts"
import { makeIo, projects, runCliWithFakes } from "./__fixtures__/io.ts"

const temp = projects()
afterEach(temp.clean)

/* D2-8 of the area D round-two review: wrangler's bare parse token named no file */
describe("migrate on D1: a wrangler config wrangler cannot read", () => {
	it("names the config before the reason wrangler gives, on every command that reads it", async () => {
		const dir = temp.make()
		writeFileSync(join(dir, "wrangler.toml"), '[[d1_databases]\nbinding = "CORE"\n[[d1_databases\n')
		mkdirSync(join(dir, "atlas-migrations"))
		writeFileSync(join(dir, "atlas-migrations", "20260101000000_init.sql"), "CREATE TABLE post (id TEXT);")
		writeSum(join(dir, "atlas-migrations"))
		const prefix = `${join(dir, "wrangler.toml")} failed to load: `
		for (const command of ["status", "check", "apply"]) {
			const io = makeIo(dir, fakeD1({ dir: join(dir, "atlas-migrations") }))
			expect(await runCliWithFakes(["migrate", command, "core", "--local"], io)).toBe(1)
			const [error] = io.errors
			expect({
				count: io.errors.length,
				named: error?.startsWith(prefix),
				reason: error?.slice(prefix.length) !== "",
			}).toEqual({ count: 1, named: true, reason: true })
		}
	})
})
