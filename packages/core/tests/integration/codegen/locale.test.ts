/**
 * F40: codegen writes the same bytes whatever the machine's locale. Under node, `localeCompare`
 * follows LANG through ICU: Danish sorts `aa` after `z`, Lithuanian `y` after `i`, so a table,
 * relation or database order decided by it would move between two developers' machines. The real
 * CLI runs under node in a child per LANG, the default locale being fixed when a process starts.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { project, useProjects } from "../support/codegen-project.ts"

useProjects()

const SRC = path.join(import.meta.dirname, "../../../src")
/* node runs comb's TypeScript source through comb's own loader hooks, as the codegen child does */
const NODE_ARGS = [
	"--experimental-import-meta-resolve",
	"--disable-warning=ExperimentalWarning",
	"--import",
	`data:text/javascript,import{install}from"${new URL(`file://${SRC}/codegen/runtime/node-hooks.mjs`).href}";install()`,
	path.join(SRC, "bin.ts"),
	"codegen",
]

/* names whose order differs by locale: aa after z in Danish, y between i and j in Lithuanian */
const TABLES = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const zebra = sqliteTable("zebra", { id: c.id("zeb"), name: c.text("name") })
export const aardvark = sqliteTable("aardvark", { id: c.id("aar"), zebraId: c.ref("zebra_id", () => zebra.id) })
export const yak = sqliteTable("yak", { id: c.id("yak"), aardvarkId: c.ref("aardvark_id", () => aardvark.id), zebraId: c.ref("zebra_id", () => zebra.id) })
export const item = sqliteTable("item", { id: c.id("itm"), yakId: c.ref("yak_id", () => yak.id) })
export const jet = sqliteTable("jet", { id: c.id("jet"), itemId: c.ref("item_id", () => item.id) })
`

/** Every file `comb codegen` wrote in a fresh project under `lang`, by its path in the project */
function generatedUnder(lang: string): Record<string, string> {
	const dir = project({
		"comb.config.ts": `export default { databases: {
	zoo: { tables: "./src/db/db.zoo.tables.ts" },
	aardb: { tables: "./src/aar/db.aardb.tables.ts" },
} }\n`,
		"src/aar/db.aardb.tables.ts": TABLES,
		"src/db/db.zoo.tables.ts": TABLES,
	})
	const env = { HOME: process.env["HOME"], LANG: lang, LC_ALL: lang, PATH: process.env["PATH"] }
	const ran = spawnSync("node", NODE_ARGS, { cwd: dir, encoding: "utf8", env })
	expect(ran.status, `${lang}: ${ran.stderr}`).toBe(0)
	const files: Record<string, string> = {}
	for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
		const file = path.relative(dir, path.join(entry.parentPath, entry.name))
		if (entry.isFile() && !file.startsWith("src/aar/db.aardb.tables") && !file.startsWith("src/db/db.zoo.tables"))
			files[file] = fs.readFileSync(path.join(dir, file), "utf8")
	}
	return files
}

describe("comb codegen under two locales (F40)", () => {
	it("writes the same bytes under en_US, da_DK and lt_LT", () => {
		const english = generatedUnder("en_US.UTF-8")
		expect(Object.keys(english).length).toBeGreaterThan(10)
		expect(generatedUnder("da_DK.UTF-8")).toEqual(english)
		expect(generatedUnder("lt_LT.UTF-8")).toEqual(english)
	}, 240_000)
})
