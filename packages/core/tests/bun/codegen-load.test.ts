/// <reference types="bun-types" />
/**
 * Codegen's loader under Bun, where its child is bun itself (load.ts): the child runs with PATH,
 * HOME and NODE_OPTIONS only, so a secret in the project's dotenv files beside the tables module
 * never reaches the module, nor a preload the project's bunfig.toml names (F41 of the 0.13.0 round).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fixtureRoot } from "../../src/codegen/__fixtures__/temp.ts"
import { loadSnapshot } from "../../src/codegen/runtime/load.ts"

let dir: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-load-bun-"))
})

afterEach(() => {
	fs.rmSync(dir, { force: true, recursive: true })
})

describe("loadSnapshot on bun with dotenv files beside the tables module (F41)", () => {
	it("loads the module with none of their variables, a bunfig preload included", () => {
		fs.writeFileSync(path.join(dir, ".env"), "COMB_F41_SECRET=leaked\n")
		fs.writeFileSync(path.join(dir, ".env.local"), "COMB_F41_LOCAL=leaked\n")
		const seen = path.join(dir, "preload-saw.json")
		fs.writeFileSync(
			path.join(dir, "preload.ts"),
			`import fs from "node:fs"\nfs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env).filter((name) => name.startsWith("COMB_F41"))))\n`,
		)
		fs.writeFileSync(path.join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
		const tables = path.join(dir, "db.core.tables.ts")
		fs.writeFileSync(
			tables,
			'const leaked = Object.keys(process.env).filter((name) => name.startsWith("COMB_F41"))\nif (leaked.length > 0) throw new Error(`the module saw ${leaked.join(", ")}`)\nexport {}\n',
		)
		expect(loadSnapshot(tables)).toMatchObject({ tables: [] })
		expect(JSON.parse(fs.readFileSync(seen, "utf8"))).toEqual([])
	})
})
