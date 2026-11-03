/**
 * KT5 of r22b: Bun compiles comb's shipped source under the consumer's tsconfig. With
 * `useDefineForClassFields: false` (projects on legacy decorators) a class field is assigned, and
 * JavaScriptCore's own non-enumerable `Error.column` took `this.column`, so a CombError's JSON body
 * and its spread dropped the column that names which one conflicted.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SRC = join(import.meta.dir, "../../src")

const PROBE = `import { CombError } from "./src/error.ts"
const error = new CombError({ column: "email", errorKey: "unique_constraint_violation", status: "conflict", table: "user" })
console.log(JSON.stringify({ body: JSON.parse(JSON.stringify(error)), spread: Object.keys({ ...error }).sort() }))
`

const made: string[] = []
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** What a CombError serializes and spreads to, compiled by Bun under a project tsconfig of `compilerOptions` */
function probe(compilerOptions: Record<string, unknown>): unknown {
	const dir = mkdtempSync(join(tmpdir(), "comb-define-fields-"))
	made.push(dir)
	mkdirSync(join(dir, "src"))
	for (const file of ["error.ts", "types.ts"]) copyFileSync(join(SRC, file), join(dir, "src", file))
	writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }))
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions }))
	writeFileSync(join(dir, "probe.ts"), PROBE)
	const ran = Bun.spawnSync([process.execPath, "probe.ts"], { cwd: dir })
	expect(ran.stderr.toString()).toBe("")
	return JSON.parse(ran.stdout.toString())
}

const SHAPE = {
	body: { column: "email", errorKey: "unique_constraint_violation", status: 409, statusKey: "conflict", table: "user" },
	spread: ["column", "errorKey", "status", "statusKey", "table"],
}

describe("a CombError keeps its column under Bun, whatever the consumer's class-field setting (KT5; sibling: the default)", () => {
	it.each([
		["useDefineForClassFields false", { target: "ES2022", useDefineForClassFields: false }],
		["legacy decorators", { experimentalDecorators: true, useDefineForClassFields: false }],
		["the default", {}],
	])("under %s", (_label, compilerOptions) => {
		expect(probe(compilerOptions)).toEqual(SHAPE)
	})
})
