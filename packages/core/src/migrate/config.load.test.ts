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
