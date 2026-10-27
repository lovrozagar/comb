/**
 * M78: public's shared history beside another schema's 0.12 rows, with a fake Atlas. A row with
 * no file of public's is ignored only when that schema's own history holds the same version and
 * hash; then, and only then, Atlas gets `--exec-order non-linear`. A history comb cannot read
 * leaves the row refused as gone, with the reason.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyWithAtlas, statusWithAtlas } from "./atlas-apply.ts"
import { sqlFiles } from "./atlas-dir.ts"
import type { AtlasRevision } from "./atlas-history.ts"
import type { Run, RunResult } from "./process.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-foreign-"))
	for (const name of ["1_a.sql", "3_c.sql"]) writeFileSync(join(dir, name), "SELECT 1;\n")
	hashed(["migrate", "hash", "--dir", `file://${dir}`])
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** Atlas's `migrate hash` of the directory `args` name, as the fixture hashes one */
function hashed(args: readonly string[]): RunResult {
	const at = (args[args.indexOf("--dir") + 1] as string).replace("file://", "")
	const lines = sqlFiles(at).map((name) => `${name} h1:${name.length}=`)
	writeFileSync(join(at, "atlas.sum"), `h1:x=\n${lines.join("\n")}\n`)
	return { code: 0, stderr: "", stdout: "" }
}

const ok = (stdout: string): RunResult => ({ code: 0, stderr: "", stdout })
const row = (version: string, hash: string, description = ""): AtlasRevision => ({
	applied: 1,
	description,
	error: "",
	errorStmt: "",
	hash,
	total: 1,
	type: "applied",
	version,
})
const status = (applied: AtlasRevision[], error = "") =>
	ok(
		JSON.stringify({
			applied,
			available: [],
			current: applied.at(-1)?.version ?? "",
			error,
			pending: [],
			status: "PENDING",
		}),
	)

type Answers = { apply?: RunResult; inspect?: RunResult; own?: RunResult; shared: RunResult }

/** Atlas answering by the history its config pins, every call kept */
function fakeAtlas(answers: Answers): Run & { calls: string[][] } {
	const calls: string[][] = []
	const exec: Run = (_cmd, args) => {
		calls.push([...args])
		if (args[1] === "hash") return hashed(args)
		if (args[0] === "schema")
			return answers.inspect ?? ok('{"schemas":[{"name":"app"},{"name":"atlas_schema_revisions_app"}]}')
		if (args[1] === "apply") return answers.apply ?? ok('{"target":"3","applied":[{"Name":"3_c.sql"}],"error":""}')
		const config = readFileSync((args[args.indexOf("--config") + 1] as string).replace("file://", ""), "utf8")
		return config.includes('"atlas_schema_revisions_app"') ? (answers.own ?? status([row("5", "b=")])) : answers.shared
	}
	return Object.assign(exec, { calls })
}

const target = {
	devUrl: "postgres://localhost/dev",
	lockTimeout: "5s",
	schema: "public",
	url: "postgres://localhost/app",
}
const approve = async () => ({ ok: true }) as const

/** public's shared history: its own a, and app's 5, which public calls c out of order for */
const OUT_OF_ORDER = "migration file 3_c.sql was added out of order"
const withApps = () => status([row("1", "7=", "a"), row("5", "b=")], OUT_OF_ORDER)
const execOrders = (calls: string[][]) => calls.filter((args) => args.includes("--exec-order"))

describe("public's history beside another schema's 0.12 rows (M78)", () => {
	it("passes no --exec-order, and reads no other history, for a history whose every row has its file", async () => {
		const atlas = fakeAtlas({ shared: status([row("1", "7=", "a")]) })
		const out: string[] = []
		await applyWithAtlas({ approve, dir, exec: atlas, print: (line) => out.push(line), target })
		expect(execOrders(atlas.calls)).toEqual([])
		expect(atlas.calls.some((args) => args[0] === "schema")).toBe(false)
	})

	it("ignores app's row, naming it, and passes non-linear to the dry run and apply only", async () => {
		const atlas = fakeAtlas({ shared: withApps() })
		const out: string[] = []
		expect(await applyWithAtlas({ approve, dir, exec: atlas, print: (line) => out.push(line), target })).toEqual([
			"3_c.sql",
		])
		expect(out[0]).toBe("5 is schema app's, recorded in atlas_schema_revisions_app; public ignores it")
		expect(execOrders(atlas.calls).map((args) => args.slice(0, 3))).toEqual([
			["migrate", "apply", "--dry-run"],
			["migrate", "apply", "--exec-order"],
		])
		const inspect = atlas.calls.find((args) => args[0] === "schema")
		expect(inspect?.slice(0, 7)).toEqual(["schema", "inspect", "--url", "env://url", "--exclude", "*.*", "--format"])
	})

	it("takes every file of public's as pending when every shared row is another schema's", async () => {
		const atlas = fakeAtlas({
			apply: ok('{"target":"3","applied":[{"Name":"1_a.sql"},{"Name":"3_c.sql"}],"error":""}'),
			shared: status([row("5", "b=")], "migration file 1_a.sql was added out of order"),
		})
		const out: string[] = []
		const check = await applyWithAtlas({
			approve,
			checkOnly: true,
			dir,
			exec: atlas,
			print: (line) => out.push(line),
			target,
		})
		expect(check).toEqual(["1_a.sql", "3_c.sql"])
		expect(out).toEqual(["5 is schema app's, recorded in atlas_schema_revisions_app; public ignores it"])
	})
})

describe("public's history beside another schema's 0.12 rows it cannot read (M78)", () => {
	it("refuses app's row as gone, naming why, when the schemas or app's own history cannot be read", async () => {
		const failures: Array<[Partial<Answers>, string]> = [
			[
				{ inspect: { code: 1, stderr: "Error: permission denied", stdout: "" } },
				"atlas schema inspect: Error: permission denied",
			],
			[{ own: { code: 1, stderr: "Error: boom", stdout: "" } }, "atlas migrate status: Error: boom"],
		]
		for (const [failing, reason] of failures) {
			const atlas = fakeAtlas({ ...failing, shared: withApps() })
			await expect(applyWithAtlas({ approve, dir, exec: atlas, print: () => undefined, target })).rejects.toThrow(
				`5 was applied, and its file is gone or renamed; another schema's history could not be read: ${reason}`,
			)
			expect(execOrders(atlas.calls)).toEqual([])
		}
		const listed = fakeAtlas({ inspect: { code: 2, stderr: "", stdout: "" }, shared: withApps() })
		const lines: string[] = []
		expect(() => statusWithAtlas({ dir, exec: listed, print: (line) => lines.push(line), target })).toThrow(
			"atlas schema inspect: exit 2",
		)
	})
})

/* G1-b: before app's own apply adopts its row, public's leftover of it is named for what it may be */
describe("public's history holding a row no schema's own history matches (G1-b)", () => {
	const gone = "5 was applied, and its file is gone or renamed"
	it("says the row may be another schema's from 0.12 when another schema exists, and not otherwise", async () => {
		const p21 = fakeAtlas({ inspect: ok('{"schemas":[{"name":"public"},{"name":"app"}]}'), shared: withApps() })
		await expect(applyWithAtlas({ approve, dir, exec: p21, print: () => undefined, target })).rejects.toThrow(
			`${gone}; if it is another schema's row from comb 0.12, run apply on that schema first to adopt it`,
		)
		const alone = fakeAtlas({
			/* a schema Atlas lists without a name suggests nothing */
			inspect: ok('{"schemas":[{"name":"public"},{"name":"atlas_schema_revisions"},{}]}'),
			shared: withApps(),
		})
		await expect(applyWithAtlas({ approve, dir, exec: alone, print: () => undefined, target })).rejects.toThrow(
			new RegExp(`^${gone}$`),
		)
	})
})

/* M79: the listing's names are used as the database has them; only the printed line is masked */
describe("public's history read with a password that spells another schema's name (M78, M79)", () => {
	it("still matches app's row and ignores it, its line masking the password", async () => {
		const atlas = fakeAtlas({ shared: withApps() })
		const out: string[] = []
		const secret = { ...target, url: "postgres://app:app@localhost/app" }
		expect(
			await applyWithAtlas({ approve, dir, exec: atlas, print: (line) => out.push(line), target: secret }),
		).toEqual(["3_c.sql"])
		expect(out[0]).toBe("5 is schema ***'s, recorded in atlas_schema_revisions_***; public ignores it")
		/* comb's own words stay whole when the password spells one: only the schema's name is masked */
		const words: string[] = []
		const spelled = { ...target, url: "postgres://app:schema@localhost/app" }
		await applyWithAtlas({
			approve,
			dir,
			exec: fakeAtlas({ shared: withApps() }),
			print: (line) => words.push(line),
			target: spelled,
		})
		expect(words[0]).toBe("5 is schema app's, recorded in atlas_schema_revisions_app; public ignores it")
		expect(execOrders(atlas.calls)).toHaveLength(2)
	})

	it("still clears Atlas's out-of-order error and applies c when the password spells its words", async () => {
		for (const password of ["order", "added"]) {
			const atlas = fakeAtlas({ shared: withApps() })
			const secret = { ...target, url: `postgres://app:${password}@localhost/app` }
			expect(await applyWithAtlas({ approve, dir, exec: atlas, print: () => undefined, target: secret })).toEqual([
				"3_c.sql",
			])
		}
	})
})
