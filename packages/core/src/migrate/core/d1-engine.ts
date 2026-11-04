/**
 * Each pending D1 file proven on D1's own engine (SD1 and SD2 of r22): after the bun:sqlite proof, the
 * files run in order on a scratch local D1 that the checked wrangler's own Miniflare opens, holding the
 * live schema and the proof's seed rows (proof-copy.ts). Miniflare runs on node, as wrangler's apply runs
 * it, whatever runtime comb runs on: the proof is a node child (d1-engine-child.mjs) started through
 * process.ts, handed its input as JSON in the proof's scratch directory, and answering D1's refusal in
 * D1's words. What D1 refuses is refused, with no override: D1's authorizer, functions, modules and
 * limits are the engine's, with no list of comb's to keep. A file whose text wrangler would rewrite is
 * refused before anything runs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProofInput, ProofResult } from "./d1-engine-child.mjs"
import { binEntry } from "./optional-peer.ts"
import { type ProjectBin, type Run, run } from "./process.ts"
import { copyScript, type LiveObject } from "./proof-copy.ts"
import { quote } from "./proof-seed.ts"

/** A pending file: its name, and its text as the migrations directory holds it */
type File = { name: string; sql: string }

/* the scratch worker's config: one D1 binding, which Miniflare keeps in memory */
const CONFIG = {
	compatibility_date: "2025-01-01",
	d1_databases: [{ binding: "DB", database_id: "00000000-0000-0000-0000-000000000000", database_name: "proof" }],
	name: "comb-d1-proof",
}

/* what wrangler's trimSqlQuery looks for: a file holding it has its first "BEGIN TRANSACTION;" and "COMMIT;" cut */
const TRIMMED = "BEGIN TRANSACTION"

/* a literal, a quoted name or a comment, as SQLite reads each */
const NOT_CODE = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g

/* what node runs, as a module file in the proof's scratch directory: it imports the child module and writes its
   answer to a file, as Miniflare may print to stdout. Not \`node -e\`: wrangler 4's getPlatformProxy never resolves
   in an evaluated module */
const SHIM = `const [child, input, output] = process.argv.slice(2)
const { main } = await import(child)
const { writeFileSync } = await import("node:fs")
writeFileSync(output, JSON.stringify(await main(input)))`

/** The literal, quoted name or comment of `sql` that holds `at`, as the file writes it */
function enclosing(sql: string, at: number): string {
	for (const match of sql.matchAll(NOT_CODE))
		if (match.index <= at && at < match.index + match[0].length) return match[0]
	return "its text"
}

/**
 * Refuses a file whose text wrangler rewrites before a local apply runs it (SD2 of r22): its trimSqlQuery
 * deletes the first `BEGIN TRANSACTION;` and `COMMIT;` wherever they are, in a literal or a comment too,
 * or refuses the file, while a remote apply sends the text as written. A real BEGIN or COMMIT is
 * refused before this, so the words are in a literal, a quoted name or a comment, or in the code of a
 * file SQLite cannot parse
 */
function refuseRewritten({ name, sql }: File): void {
	const at = sql.indexOf(TRIMMED)
	if (at === -1) return
	throw new Error(
		`${name}: ${enclosing(sql, at)} holds "${TRIMMED}", and wrangler rewrites a file that does before a local apply runs it: it deletes the first "BEGIN TRANSACTION;" and the first "COMMIT;" wherever they are, literals and comments too, or refuses the file (its trimSqlQuery), so a local apply would store other data than check proves and a remote apply stores; split the words, as in 'BEGIN ' || 'TRANSACTION'`,
	)
}

/**
 * What the proof's child runs: the scratch worker's config, written to `dir`; the copy of the live schema
 * `live` and the history table `table` as the seed batch; each of `files` with the history row wrangler
 * appends to it; and the entry of the checked wrangler `bin`
 */
async function proofInput(
	live: readonly LiveObject[],
	files: readonly File[],
	{ bin, dir, table }: { bin: ProjectBin; dir: string; table: string },
): Promise<ProofInput> {
	const configPath = join(dir, "wrangler.json")
	writeFileSync(configPath, JSON.stringify(CONFIG))
	const history = `CREATE TABLE IF NOT EXISTS ${quote(table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`
	return {
		configPath,
		files: files.map(({ name, sql }) => ({
			name,
			query: `${sql}\nINSERT INTO ${quote(table)} (name)\nvalues ('${name.replaceAll("'", "''")}');`,
		})),
		seed: [...(await copyScript(live, files, table)), history],
		wrangler: binEntry(bin),
	}
}

/**
 * Proves `files`, in order, on a scratch D1 of the checked wrangler `bin` holding the copy of the live
 * schema `live`, in a child on wrangler's runtime that `exec` starts; `table` is the binding's migration
 * history, which each file's appended row goes to. Throws D1's refusal, or how the child failed
 */
async function proveOnD1(
	live: readonly LiveObject[],
	files: readonly File[],
	{ bin, exec = run, table }: { bin: ProjectBin; exec?: Run | undefined; table: string },
): Promise<void> {
	for (const file of files) refuseRewritten(file)
	const dir = mkdtempSync(join(tmpdir(), "comb-d1-proof-"))
	try {
		const input = join(dir, "input.json")
		const output = join(dir, "result.json")
		writeFileSync(input, JSON.stringify(await proofInput(live, files, { bin, dir, table })))
		const child = new URL("./d1-engine-child.mjs", import.meta.url).href
		const shim = join(dir, "proof.mjs")
		writeFileSync(shim, SHIM)
		const ran = exec(bin.runtime, [shim, child, input, output], { peer: bin.peer })
		if (!existsSync(output))
			throw new Error(
				`check could not prove the pending files on D1's engine: the proof on ${bin.runtime} ended with code ${ran.code} and no answer: ${ran.stderr.trim() || "it printed nothing"}`,
			)
		const { refused } = JSON.parse(readFileSync(output, "utf8")) as ProofResult
		if (refused !== undefined) throw new Error(refused)
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

export { enclosing, proofInput, proveOnD1, refuseRewritten }
