/**
 * M77: 0.12's shared history, read for a schema whose own records nothing. The rows naming this
 * directory's files must be a prefix of them, in order, whole, with the hashes Atlas records now;
 * a row naming no file here is another schema's. Once the schema's own history records a file,
 * the shared history is never read again.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { adopted, adopts, proveAdoption, sharedPrefix } from "./atlas-adopt.ts"
import { applyWithAtlas, statusWithAtlas } from "./atlas-apply.ts"
import { sqlFiles } from "./atlas-dir.ts"
import type { AtlasRevision, AtlasStatus } from "./atlas-history.ts"
import type { LiveRead } from "./pg-live-types.ts"
import type { Run, RunResult } from "./process.ts"

let dir = ""
/** A print that keeps nothing */
const print = () => undefined
/** `files` as the snapshot, its sum hashed as `h1:<name length>=` for each */
function snapshot(files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	const lines = sqlFiles(dir).map((name) => `${name} h1:${name.length}=`)
	writeFileSync(join(dir, "atlas.sum"), `h1:x=\n${lines.join("\n")}\n`)
}
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-adopt-"))
	snapshot({ "1_a.sql": "SELECT 1;\n", "2_b.sql": "SELECT 2;\n", "3_c.sql": "SELECT 3;\n" })
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** Atlas's `migrate hash` of the directory `args` name, as the fixture hashes one */
function hashed(args: readonly string[]): RunResult {
	const at = (args[args.indexOf("--dir") + 1] as string).replace("file://", "")
	const lines = sqlFiles(at).map((name) => `${name} h1:${name.length}=`)
	writeFileSync(join(at, "atlas.sum"), `h1:x=\n${lines.join("\n")}\n`)
	return { code: 0, stderr: "", stdout: "" }
}

/** Atlas on a database with objects whose own history is empty: every status refused as not clean */
const notClean: Run = (_cmd, args) =>
	args[1] === "hash"
		? hashed(args)
		: {
				code: 1,
				stderr: 'Error: sql/migrate: connected database is not clean: found table "t" in schema "app".',
				stdout: "",
			}

/** A row of the shared history for `name`, whole and with the snapshot's hash unless `more` says otherwise */
function row(name: string, more: Partial<AtlasRevision> = {}): AtlasRevision {
	const [version = "", description = ""] = name.replace(/\.sql$/, "").split(/_(.*)/s)
	return {
		applied: 1,
		description,
		error: "",
		errorStmt: "",
		hash: `${name.length}=`,
		total: 1,
		type: "applied",
		version,
		...more,
	}
}

const shared = (applied: AtlasRevision[]): AtlasStatus => ({
	applied,
	available: [],
	current: "",
	error: "",
	pending: [],
	status: "OK",
})

/* what status and check say of the files 0.12 ran, which they do not prove (P2) */
const PENDING =
	"ran under 0.12's shared history; apply would adopt them, pending proof that the schema holds what they leave"

describe("sharedPrefix: the files 0.12's shared history ran", () => {
	it("takes the rows naming this directory's files as its prefix, and skips another schema's", () => {
		expect(sharedPrefix(shared([row("0_public.sql"), row("1_a.sql"), row("2_b.sql"), row("9_x.sql")]), dir)).toEqual([
			"1_a.sql",
			"2_b.sql",
		])
		expect(sharedPrefix(shared([row("0_public.sql")]), dir)).toEqual([])
	})

	it("refuses a skipped file, a file run halfway or failed, and a file that changed, naming it", () => {
		expect(() => sharedPrefix(shared([row("2_b.sql")]), dir)).toThrow(
			"0.12's shared history records 2_b.sql but not 1_a.sql, which comes before it, so comb cannot tell what ran; record it by hand",
		)
		for (const halfway of [{ applied: 1, total: 2 }, { error: "pq: boom" }])
			expect(() => sharedPrefix(shared([row("1_a.sql", halfway)]), dir)).toThrow(
				"1_a.sql ran halfway under 0.12; finish or revert it by hand",
			)
		expect(() => sharedPrefix(shared([row("1_a.sql"), row("2_b.sql", { hash: "other=" })]), dir)).toThrow(
			"2_b.sql is not the file 0.12 ran: its hash is not the one the shared history recorded; restore it, and apply adopts it",
		)
	})

	it("says how many files ran, and which it recorded", () => {
		expect(adopts(["1_a.sql"])).toBe(`1 file ${PENDING}`)
		expect(adopts(["1_a.sql", "2_b.sql"])).toBe(`2 files ${PENDING}`)
		expect(adopted(["1_a.sql", "2_b.sql"])).toBe("Adopted from 0.12's shared history: 1_a.sql, 2_b.sql")
	})
})

describe("adoption: read once, while the schema's own history is empty", () => {
	it("never reads the shared history once the schema's own records a file", async () => {
		const histories: string[] = []
		const exec: Run = (_cmd, args) => {
			if (args[1] === "hash") return hashed(args)
			const config = readFileSync((args[args.indexOf("--config") + 1] as string).replace("file://", ""), "utf8")
			histories.push(/revisions_schema = "([^"]+)"/.exec(config)?.[1] ?? "")
			const status = { ...shared([row("1_a.sql"), row("2_b.sql"), row("3_c.sql")]), current: "3" }
			return { code: 0, stderr: "", stdout: JSON.stringify(status) }
		}
		const target = {
			devUrl: "postgres://localhost/dev",
			lockTimeout: "5s",
			schema: "app",
			url: "postgres://localhost/app",
		}
		expect(await applyWithAtlas({ approve: async () => ({ ok: true }), dir, exec, print, target })).toEqual([])
		expect(histories).toEqual(["atlas_schema_revisions_app"])
	})

	/* the report's M77 case: an earlier refused apply left the own history empty, so Atlas calls the database not clean */
	it("refuses a database with objects, an empty own history and no shared rows, in status and apply alike", async () => {
		const target = {
			devUrl: "postgres://localhost/dev",
			lockTimeout: "5s",
			schema: "app",
			url: "postgres://localhost/app",
		}
		const refusal = /^atlas migrate status: the database has objects but no migration history/
		expect(() => statusWithAtlas({ dir, exec: notClean, print, target })).toThrow(refusal)
		await expect(
			applyWithAtlas({ approve: async () => ({ ok: true }), dir, exec: notClean, print, target }),
		).rejects.toThrow(refusal)
	})

	it("says nothing is pending when 0.12 ran every file, and writes nothing", () => {
		const calls: string[][] = []
		const allRan: Run = (_cmd, args) => {
			calls.push([...args])
			if (args[1] === "hash") return hashed(args)
			const config = readFileSync((args[args.indexOf("--config") + 1] as string).replace("file://", ""), "utf8")
			const rows = config.includes('"atlas_schema_revisions"') ? [row("1_a.sql"), row("2_b.sql"), row("3_c.sql")] : []
			return { code: 0, stderr: "", stdout: JSON.stringify(shared(rows)) }
		}
		const out: string[] = []
		const target = {
			devUrl: "postgres://localhost/dev",
			lockTimeout: "5s",
			schema: "app",
			url: "postgres://localhost/app",
		}
		expect(statusWithAtlas({ dir, exec: allRan, print: (line) => out.push(line), target })).toEqual({
			applied: [],
			pending: [],
		})
		expect(out).toEqual(["Applied: 0", "Pending: none", `3 files ${PENDING}`])
		expect(calls.map((args) => args[1])).toEqual(["hash", "status", "status"])
	})
})

/* P2 of the 0.14.1 review: a matching prefix is adopted only once the schema holds what replaying it leaves */
/** A database with no function, procedure or trigger */
const noObjects: LiveRead = async () => ({ routines: new Map(), triggers: new Map() })

/** atlas, its schema diff answering `stdout` and `stderr` */
const diffing =
	(stdout: string, stderr = ""): Run =>
	(_cmd, args) =>
		args[0] === "schema" ? { code: 0, stderr, stdout } : { code: 0, stderr: "", stdout: "" }

/** atlas, its schema diff failing to reach the dev database */
const unreachable: Run = (_cmd, args) =>
	args[0] === "schema"
		? { code: 1, stderr: "Error: dial tcp: lookup dev: no such host", stdout: "" }
		: { code: 0, stderr: "", stdout: "" }

describe("proveAdoption", () => {
	const target = { devUrl: "postgres://dev/dev", lockTimeout: "5s", schema: "app", url: "postgres://db/db" }

	it("passes a schema that holds what the files leave, passing Atlas's notices on", async () => {
		const copy = mkdtempSync(join(tmpdir(), "comb-prove-"))
		writeFileSync(join(copy, "1_a.sql"), 'CREATE TABLE "a" ("id" integer);\n')
		const out: string[] = []
		const exec = diffing("Schemas are synced, no changes to be made.", "views are not inspected")
		await proveAdoption(
			{ exec, print: (line) => out.push(line), readLive: noObjects, readyDev: async () => undefined, target },
			copy,
			["1_a.sql"],
		)
		expect(out).toEqual(["Warning: Atlas: views are not inspected"])
		rmSync(copy, { force: true, recursive: true })
	})

	/* a ruling on P2: proof replays on the dev database, so one Atlas cannot reach refuses by its name */
	it("refuses, naming devUrl, when Atlas cannot replay the files on the dev database", async () => {
		const copy = mkdtempSync(join(tmpdir(), "comb-prove-"))
		writeFileSync(join(copy, "1_a.sql"), 'CREATE TABLE "a" ("id" integer);\n')
		await expect(
			proveAdoption(
				{ exec: unreachable, print: () => undefined, readLive: noObjects, readyDev: async () => undefined, target },
				copy,
				["1_a.sql"],
			),
		).rejects.toThrow(
			"adopting 0.12's shared history needs devUrl, an empty Postgres database Atlas can reach, to prove app holds what it ran (1_a.sql); devUrl could not be used: atlas schema diff: Error: dial tcp: lookup dev: no such host",
		)
		rmSync(copy, { force: true, recursive: true })
	})

	it("refuses one that does not, naming the schema and the files, with the difference", async () => {
		const copy = mkdtempSync(join(tmpdir(), "comb-prove-"))
		writeFileSync(join(copy, "1_a.sql"), 'CREATE TABLE "a" ("id" integer);\n')
		const exec = diffing('-- Create "a" table\nCREATE TABLE "a" ("id" integer);')
		await expect(
			proveAdoption(
				{ exec, print: () => undefined, readLive: noObjects, readyDev: async () => undefined, target },
				copy,
				["1_a.sql"],
			),
		).rejects.toThrow(
			"app does not hold what 0.12's shared history ran (1_a.sql), so comb adopts none of it; the difference:\n-- Create",
		)
		rmSync(copy, { force: true, recursive: true })
	})
})
