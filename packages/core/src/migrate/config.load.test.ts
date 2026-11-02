/**
 * K5 of r20: loadConfig under Node, which reads an import specifier as a URL, so a bare path with
 * `%20` decodes to another directory and one with `#` loses its tail as a fragment. Node 26 strips
 * the types of a .ts file outside node_modules, so it runs config.ts as tsx would.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { findConfigFile, loadConfig } from "./config.ts"

const CONFIG = pathToFileURL(join(import.meta.dirname, "config.ts")).href

/* a config whose one database is named `key`, so the run says which file it loaded */
const configOf = (key: string) =>
	`export default { databases: { ${key}: { migrationsDir: "m", name: "${key}", provider: { databaseName: "${key}", type: "d1" } } } }\n`

/** The database keys loadConfig reads in `cwd`, run under Node; the error's first line when it throws */
function loadUnderNode(cwd: string): string {
	const script = `const { loadConfig } = await import(${JSON.stringify(CONFIG)})
try {
	const { config, configDir } = await loadConfig(undefined, ${JSON.stringify(cwd)})
	console.log(Object.keys(config.databases).join(","), configDir === ${JSON.stringify(cwd)})
} catch (error) {
	console.log("threw", String(error.message).split("\\n")[0])
}`
	const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" })
	return `${result.stdout}${result.stderr}`.trim()
}

describe("loadConfig under Node, in a directory whose name a URL reads otherwise", () => {
	let root: string
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "comb-config-load-"))
		/* `my proj` is what `my%20proj` decodes to, and `proj` what `proj#2` loses its fragment to */
		for (const [dir, key] of [
			["my%20proj", "here"],
			["my proj", "decoy"],
			["proj#2", "here"],
			["proj", "decoy"],
		] as const) {
			mkdirSync(join(root, dir))
			writeFileSync(join(root, dir, "comb.migrate.config.ts"), configOf(key))
		}
	})
	afterAll(() => rmSync(root, { force: true, recursive: true }))

	it.each(["my%20proj", "proj#2"])("loads the config in %s, not another directory's", (dir) => {
		expect(loadUnderNode(join(root, dir))).toBe("here true")
	})
})

/* K6 of r20: comb read four names other migration tools use, and ran whatever file held one */
describe("a migration.config.ts is never imported", () => {
	const LEGACY = ["db-migration.config.ts", "db-migration.config.js", "migration.config.ts", "migration.config.js"]
	/* a file that says so if anything imports it */
	const OTHER_TOOL = 'throw new Error("another tool\'s config ran")\n'
	let root: string
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "comb-config-legacy-"))
	})
	afterAll(() => rmSync(root, { force: true, recursive: true }))

	it.each(LEGACY)("%s beside comb.migrate.config.ts: comb loads its own", async (name) => {
		const dir = join(root, `with-${name}`)
		mkdirSync(dir)
		writeFileSync(join(dir, name), OTHER_TOOL)
		writeFileSync(join(dir, "comb.migrate.config.ts"), configOf("here"))
		expect(findConfigFile(dir)).toBe(join(dir, "comb.migrate.config.ts"))
		expect(Object.keys((await loadConfig(undefined, dir)).config.databases)).toEqual(["here"])
	})

	it.each(LEGACY)("%s alone: refused unrun, naming the rename", async (name) => {
		const dir = join(root, `alone-${name}`)
		mkdirSync(dir)
		writeFileSync(join(dir, name), OTHER_TOOL)
		const refusal = `comb no longer reads ${name}, and did not run it: rename it to comb.migrate.config.ts if it is comb's migrate config, or add a comb.migrate.config.ts beside it if it is another tool's`
		expect(() => findConfigFile(dir)).toThrow(refusal)
		await expect(loadConfig(undefined, dir)).rejects.toThrow(refusal)
	})

	it("names only comb's own files when a project has none", async () => {
		await expect(loadConfig(undefined, root)).rejects.toThrow(
			"No config file found. Create comb.migrate.config.ts (or comb.migrate.config.js)",
		)
	})
})
