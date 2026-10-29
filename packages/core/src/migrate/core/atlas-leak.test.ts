/**
 * M79's structural guard: comb decides on Atlas's text as Atlas wrote it, so every path that
 * prints any of it must scrub it. Each Atlas path here runs against a fake whose stdout and stderr
 * both carry the target's password, and nothing comb throws or prints may hold it.
 */
import type { LiveObjects } from "./pg-live-types.ts"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyWithAtlas, baselineWithAtlas, statusWithAtlas } from "./atlas-apply.ts"
import { sqlFiles } from "./atlas-dir.ts"
import type { Run, RunResult } from "./process.ts"

const SECRET = "Pw0rd-Secret"
const target = (schema = "app") => ({
	devUrl: "postgres://localhost/dev",
	lockTimeout: "5s",
	schema,
	url: `postgres://app:${SECRET}@db/app`,
})
const LEAK = `dial postgres://app:${SECRET}@db/app: ${SECRET} rejected`

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-leak-"))
	writeFileSync(join(dir, "1_a.sql"), 'CREATE TABLE "a" ("id" int);\n')
	writeFileSync(join(dir, "2_b.sql"), 'CREATE TABLE "b" ("id" int);\n')
	hashed(["migrate", "hash", "--dir", `file://${dir}`])
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** Atlas's `migrate hash` of the directory `args` name */
function hashed(args: readonly string[]): RunResult {
	const at = (args[args.indexOf("--dir") + 1] as string).replace("file://", "")
	const lines = sqlFiles(at).map((name) => `${name} h1:${name.length}=`)
	writeFileSync(join(at, "atlas.sum"), `h1:x=\n${lines.join("\n")}\n`)
	return { code: 0, stderr: "", stdout: "" }
}

const failing: RunResult = { code: 1, stderr: LEAK, stdout: LEAK }
const json = (body: unknown): RunResult => ({ code: 0, stderr: LEAK, stdout: JSON.stringify(body) })
const revision = (version: string, more: Record<string, unknown> = {}) => ({
	applied: 1,
	description: version === "1" ? "a" : "b",
	error: "",
	errorStmt: "",
	hash: "7=",
	total: 1,
	type: "applied",
	version,
	...more,
})
const status = (body: Record<string, unknown>) =>
	json({ applied: [], available: [], current: "", error: "", pending: [], status: "OK", ...body })
const PENDING = { pending: [{ Description: "b", Name: "2_b.sql", Version: "2" }], status: "PENDING" }
const ONE = { applied: [revision("1")], current: "1", ...PENDING }

/** Atlas answering each call by its kind, every call scripted to carry the password */
function fake(answers: {
	apply?: RunResult
	dry?: RunResult
	inspect?: RunResult
	schemaDiff?: RunResult
	set?: RunResult
	status: RunResult
}): Run {
	return (_cmd, args) => {
		if (args[1] === "hash") return hashed(args)
		if (args[0] === "schema") return (args[1] === "inspect" ? answers.inspect : answers.schemaDiff) ?? failing
		if (args[1] === "status") return answers.status
		if (args[1] === "set") return answers.set ?? failing
		return (args.includes("--dry-run") ? answers.dry : answers.apply) ?? failing
	}
}

/** What `body` throws and prints, the password nowhere in it */
async function leaks(body: (print: (line: string) => void) => unknown): Promise<string> {
	const lines: string[] = []
	let thrown = ""
	try {
		await body((line) => lines.push(line))
	} catch (error) {
		thrown = (error as Error).message
	}
	return [thrown, ...lines].join("\n")
}

const approve = async () => ({ ok: true }) as const

/* the catalog read reaches no database: its schema holds no function or trigger */
const noObjects = async (): Promise<LiveObjects> => ({
	policies: new Map(),
	relations: new Map(),
	routines: new Map(),
	triggers: new Map(),
})

describe("no Atlas path prints the target's password (M79)", () => {
	it("scrubs every apply and check failure Atlas reports", async () => {
		const runs: Array<Parameters<typeof fake>[0]> = [
			{ status: failing },
			{ status: status({ ...ONE, error: LEAK }) },
			{ dry: failing, status: status(ONE) },
			{
				apply: json({ applied: [{ Error: { Stmt: LEAK, Text: LEAK }, Name: "2_b.sql" }], error: "" }),
				dry: json({}),
				status: status(ONE),
			},
			{ apply: json({ applied: [], error: LEAK }), dry: json({}), status: status(ONE) },
			{ apply: { code: 1, stderr: LEAK, stdout: "" }, dry: json({}), status: status(ONE) },
			{ inspect: failing, status: status(PENDING) },
		]
		for (const answers of runs) {
			for (const checkOnly of [false, true]) {
				const said = await leaks((print) =>
					applyWithAtlas({ approve, checkOnly, dir, exec: fake(answers), print, target: target() }),
				)
				expect(said).not.toContain(SECRET)
			}
		}
	})

	it("scrubs what status prints of a file run halfway and of Atlas's error, and every baseline failure", async () => {
		const half = status({
			applied: [revision("2", { applied: 1, error: LEAK, errorStmt: LEAK, total: 2 })],
			current: "2",
		})
		for (const answers of [{ status: half }, { status: status({ ...ONE, error: LEAK }) }, { status: failing }]) {
			const said = await leaks((print) => statusWithAtlas({ dir, exec: fake(answers), print, target: target() }))
			expect(said).not.toContain(SECRET)
		}
		const empty = status({})
		for (const answers of [
			{ schemaDiff: failing, status: empty },
			{ schemaDiff: { code: 0, stderr: LEAK, stdout: LEAK }, status: empty },
			{ schemaDiff: { code: 0, stderr: "", stdout: "Schemas are synced, no changes to be made." }, status: empty },
		]) {
			const said = await leaks((print) =>
				baselineWithAtlas({ dir, exec: fake(answers), print, readLive: noObjects, target: target() }),
			)
			expect(said).not.toContain(SECRET)
		}
	})
})

describe("no Atlas path prints the target's password (M79): another schema's history", () => {
	it("scrubs why public could not read another schema's history", async () => {
		const shared = status({ applied: [revision("1"), revision("5", { hash: "b=" })], current: "5" })
		const said = await leaks((print) =>
			applyWithAtlas({
				approve,
				dir,
				exec: fake({ inspect: failing, status: shared }),
				print,
				target: target("public"),
			}),
		)
		expect(said).toContain("another schema's history could not be read")
		expect(said).not.toContain(SECRET)
	})
})

/** A target whose password is `password`, and Atlas echoing it in a not-clean refusal */
const at = (password: string) => ({ ...target(), url: `postgres://app:${password}@db/app` })
const echo = (password: string) =>
	`Error: sql/migrate: connected database is not clean: dial postgres://app:${password}@db/app`

/* CI's Postgres password is `comb`: a scrub must touch only what Atlas wrote, never comb's own words */
describe("comb's own words, whatever the password spells (M79)", () => {
	it("keeps the not-clean refusal whole under CI's password, and masks the password Atlas echoed", async () => {
		/* CI's path: a database with tables and no history, whose dry run Atlas refuses as not clean */
		const notClean = fake({ dry: { code: 1, stderr: echo("comb"), stdout: "" }, status: status(PENDING) })
		await expect(
			applyWithAtlas({ approve, dir, exec: notClean, print: () => undefined, target: at("comb") }),
		).rejects.toThrow(
			"the database has objects but no migration history, and no shared history row matches this directory's files (a database made by hand, or another directory's history); if its schema matches the migrations, record them with comb migrate baseline",
		)
	})

	it("keeps each explained sentence whole when the password is one of its words", async () => {
		const explained: Array<[string, string]> = [
			["Error: docker: Cannot connect to the Docker daemon", "set devUrl to an empty Postgres database instead"],
			["Error: lock is held by other session", "run it again once that one finishes"],
			[
				"Error: migration file 2_b.sql was added out of order",
				"is older than a migration already applied; rename it to a newer version and run atlas migrate hash",
			],
			['Error: dropping value "x" from enum "e" is not supported', "write that migration by hand"],
			["Error: functions are available to logged-in users only", "take them out of the drizzle schema"],
		]
		for (const [stderr, sentence] of explained) {
			for (const password of ["comb", ...sentence.split(/\W+/).filter((word) => word.length > 2)]) {
				const said = await leaks((print) =>
					applyWithAtlas({
						approve,
						dir,
						exec: fake({ status: { code: 1, stderr: `${stderr} ${password}@`, stdout: "" } }),
						print,
						target: at(password),
					}),
				)
				expect([password, said]).toEqual([password, expect.stringContaining(sentence)])
			}
		}
	})
})
