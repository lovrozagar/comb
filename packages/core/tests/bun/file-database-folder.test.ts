/// <reference types="bun-types" />
/**
 * D6-7 of the area D round-six review on bun:sqlite itself (sibling: src/cli/migrate-apply.test.ts, a libsql
 * file): apply creates a missing folder for the database it creates, and an open that fails names the path.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fakeAtlas, writeSum } from "../../src/cli/__fixtures__/d1.ts"
import { makeIo, projects, runCliWithFakes } from "../../src/cli/__fixtures__/io.ts"

const temp = projects()
afterEach(temp.clean)

/** A project over a bun:sqlite database at `db` in it, with one migration in ./m */
function configured(db: string): string {
	const dir = temp.make()
	mkdirSync(join(dir, "m"))
	writeFileSync(join(dir, "m", "0001_t.sql"), "CREATE TABLE t (id INTEGER);\n")
	writeSum(join(dir, "m"))
	const provider = { path: join(dir, db), type: "bun-sqlite" }
	writeFileSync(
		join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", name: "core-dev", provider: ${JSON.stringify(provider)} } } }\n`,
	)
	return dir
}

describe("migrate apply on a bun:sqlite file whose folder is missing", () => {
	it("creates the folder, as it creates the file, and applies", async () => {
		const dir = configured("missing/sub/core.db")
		const io = makeIo(dir, fakeAtlas())
		expect(await runCliWithFakes(["migrate", "apply", "core", "--yes"], io)).toBe(0)
		expect(existsSync(join(dir, "missing/sub/core.db"))).toBe(true)
	})

	it("names the path it tried when the database cannot open", async () => {
		const dir = configured("taken/core.db")
		mkdirSync(join(dir, "taken/core.db"), { recursive: true })
		const io = makeIo(dir, fakeAtlas())
		expect(await runCliWithFakes(["migrate", "apply", "core", "--yes"], io)).toBe(1)
		expect(io.errors.join("\n")).toContain(`cannot open the SQLite database ${join(dir, "taken/core.db")}: `)
	})
})
