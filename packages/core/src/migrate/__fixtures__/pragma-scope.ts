/**
 * S1 of r21: a connection-scoped pragma one file approves for itself must end with that file, as it
 * does on D1, where wrangler runs each file alone. 0001 approves `PRAGMA ignore_check_constraints =
 * 1` for its own backfill; 0002 is a plain INSERT that breaks t's CHECK, refused together as apart.
 * The siblings: each connection setting a file can approve, set by one file and read by the next.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCli } from "../../cli/index.ts"
import { run } from "../core/process.ts"

/** A project whose one database, core, is an empty SQLite file on `provider`, with migrations in ./m */
export type ScopeProject = {
	db: string
	dir: string
	remove(): void
	write(files: Record<string, string>): Promise<void>
}

export async function scopeProject(
	provider: "bun-sqlite" | "libsql",
	files: Record<string, string>,
): Promise<ScopeProject> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-pragma-scope-"))
	const [db, m] = [path.join(dir, "core.db"), path.join(dir, "m")]
	fs.mkdirSync(m)
	/* an empty file is an empty database, which check reads; it creates none */
	fs.writeFileSync(db, "")
	const config = provider === "libsql" ? { type: "libsql", url: `file:${db}` } : { path: db, type: "bun-sqlite" }
	fs.writeFileSync(
		path.join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", name: "core", provider: ${JSON.stringify(config)} } } }\n`,
	)
	const write = async (more: Record<string, string>) => {
		for (const [name, sql] of Object.entries(more)) fs.writeFileSync(path.join(m, name), sql)
		await run("atlas", ["migrate", "hash", "--dir", `file://${m}`])
	}
	await write(files)
	return { db, dir, remove: () => fs.rmSync(dir, { force: true, recursive: true }), write }
}

/** `comb migrate <mode> core --yes` in `dir`: its exit code, and what it printed */
export async function migrate(dir: string, mode: "apply" | "check"): Promise<{ code: number; text: string }> {
	const lines: string[] = []
	const code = await runCli(["migrate", mode, "core", "--yes"], {
		cwd: dir,
		err: (line) => lines.push(line),
		out: (line) => lines.push(line),
	})
	return { code, text: lines.join("\n") }
}

/** 0000: a table, applied first, so the target is not the empty one the unsafe gate passes whole */
export const KEEP = { "0000_keep.sql": "CREATE TABLE keep (x INTEGER);\n" }

/** 0001: a table with a CHECK, and a backfill that breaks it under the pragma it approves */
export const IGNORE_CHECKS =
	"-- comb:allow-unsafe: legacy rows predate the check\nCREATE TABLE t (v INTEGER CHECK (v > 0));\nPRAGMA ignore_check_constraints = 1;\nINSERT INTO t (v) VALUES (-1);\n"

/** 0002: a plain insert that breaks t's CHECK, which nothing approved */
export const BREAKS_CHECK = "INSERT INTO t (v) VALUES (-5);\n"

/** A connection setting a file can approve: what the file sets it to, and how the next file reads it */
export type ScopedPragma = { name: string; read: string; set: string }

/**
 * The siblings: each set away from SQLite's default, read through its table-valued function. case_sensitive_like has no getter, so the next
 * file reads what it does to LIKE.
 */
export const SCOPED_PRAGMAS: readonly ScopedPragma[] = [
	{ name: "recursive_triggers", read: "SELECT recursive_triggers FROM pragma_recursive_triggers", set: "1" },
	{ name: "legacy_alter_table", read: "SELECT legacy_alter_table FROM pragma_legacy_alter_table", set: "1" },
	{ name: "case_sensitive_like", read: "SELECT 'a' LIKE 'A'", set: "1" },
	{
		name: "reverse_unordered_selects",
		read: "SELECT reverse_unordered_selects FROM pragma_reverse_unordered_selects",
		set: "1",
	},
	{ name: "automatic_index", read: "SELECT automatic_index FROM pragma_automatic_index", set: "0" },
	{ name: "cell_size_check", read: "SELECT cell_size_check FROM pragma_cell_size_check", set: "1" },
	{
		name: "ignore_check_constraints",
		read: "SELECT ignore_check_constraints FROM pragma_ignore_check_constraints",
		set: "1",
	},
]

/** Two files: the first approves and sets `pragma`, the second keeps what it reads in `seen` */
export function setThenRead(pragma: ScopedPragma): Record<string, string> {
	return {
		"0001_set.sql": `-- comb:allow-unsafe: the file's own setting\nPRAGMA ${pragma.name} = ${pragma.set};\nCREATE TABLE marker (id INTEGER);\n`,
		"0002_read.sql": `CREATE TABLE seen (v INTEGER);\nINSERT INTO seen (v) ${pragma.read};\n`,
	}
}
