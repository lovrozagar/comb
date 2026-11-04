/**
 * comb starts new work, a process, a database connection or session, or a request, in a few seams
 * alone, and each waits for a signal's stop to end before it starts any (pastStop of cleanup.ts,
 * r22b): a loop between steps while a stop's cleanup runs, a replay's next file or a proof's next
 * scratch among them, then starts nothing the cleanup would miss. A file that starts such work is a
 * seam that awaits pastStop, or names here why it needs none, so a new loop cannot go around them.
 * Each seam's own unit case pins that a stop pending before the call starts nothing.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "../../src")

/* what starts new work: a process, postgres.js or pg, a SQLite or libsql database, a libsql client, a request */
const STARTS =
	/\bfrom\s+["'](?:node:)?child_process["']|\bimport\(\s*(?:PEER|["']postgres["'])\s*\)|\bfrom\s+["'](?:postgres|pg)["']|\bnew\s+(?:Database|DatabaseSync|Client|Pool)\s*\(|\bcreateClient\s*\(|\bfetch\s*\(/

/** Whether `text` starts new work directly */
export function startsWork(text: string): boolean {
	return STARTS.test(text)
}

// lookup-table: each file under src that starts new work, and how it waits for a stop, or why it need not
const SEAMS: Readonly<Record<string, string>> = {
	"codegen/generators/orm.ts": "writes a consumer's code, whose clients comb never opens",
	"codegen/runtime/supervise.mjs":
		"a process of its own that loads no comb module: it starts its one child before it listens for a signal, and kills that child's group on one",
	"migrate/core/pg-live-objects.ts": "pastStop",
	"migrate/core/process.ts": "pastStop",
	"migrate/drivers/bun-sqlite.ts": "pastStop",
	"migrate/drivers/libsql-file.ts": "pastStop",
	"migrate/drivers/libsql-client.ts":
		"declares @libsql/client's createClient and loads the module, whose clients only sqlite.ts's connects make, once past a stop",
	"migrate/drivers/libsql-local.ts":
		"opens only through local-db.ts's opener, which openScratch and openMemory call once past a stop",
	"migrate/drivers/local-db.ts": "pastStop",
	"migrate/drivers/sqlite.ts": "pastStop",
}

/** Each source file under `dir` but tests and test fixtures, which never ship */
function sources(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				/\.(?:ts|mjs)$/.test(entry.name) &&
				!entry.name.endsWith(".test.ts") &&
				!entry.parentPath.split("/").includes("__fixtures__"),
		)
		.map((entry) => join(entry.parentPath, entry.name))
}

describe("stop seams", () => {
	const starters = sources(SRC).filter((file) => startsWork(readFileSync(file, "utf8")))

	it("starts new work only in the files named here", () => {
		expect(starters.map((file) => relative(SRC, file)).toSorted()).toEqual(Object.keys(SEAMS).toSorted())
	})

	it.each(Object.entries(SEAMS).filter(([, how]) => how === "pastStop"))("%s awaits pastStop", (file) => {
		expect(readFileSync(join(SRC, file), "utf8")).toMatch(/\bawait pastStop\(\)/)
	})

	it.each([
		['import { spawn } from "node:child_process"', true],
		["return (await import(PEER)) as { default: Connect }", true],
		['import pg from "pg"', true],
		["const db = new Database(file)", true],
		["const db = new DatabaseSync(file)", true],
		["const client = createClient({ url })", true],
		["const res = await request.fetch(url)", true],
		['const s = "a Database is opened"', false],
		['import { pastStop } from "./cleanup.ts"', false],
	])("the checker: %s → %s", (text, expected) => {
		expect(startsWork(text)).toBe(expected)
	})
})
