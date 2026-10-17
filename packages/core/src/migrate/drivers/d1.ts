/**
 * Cloudflare D1 driver — shells out to `wrangler d1 execute`
 * since D1 has no HTTP API for external access.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as z from "zod"
import { type Run, run } from "../core/process.ts"
import { segments } from "../core/sql-scan.ts"
import type { Connection, ConnectionProvider, D1ProviderConfig, QueryResult, ResolvedDatabaseConfig } from "../types.ts"

/* wrangler JSON output schema for query results, built on use: each command parses it once */
const wranglerResultSchema = () =>
	z.array(z.object({ results: z.array(z.record(z.string(), z.unknown())).default([]) }))

/** The rows of `wrangler d1 execute --json`; output of any other shape is an error, never "no rows" */
function readResults(stdout: string): Array<Record<string, unknown>> {
	let json: unknown
	try {
		json = JSON.parse(stdout)
	} catch {
		throw new Error(`wrangler printed output that is not JSON: ${stdout.trim().slice(0, 200)}`)
	}
	const parsed = wranglerResultSchema().safeParse(json)
	if (!parsed.success) throw new Error(`wrangler printed JSON comb cannot read: ${stdout.trim().slice(0, 200)}`)
	return parsed.data[0]?.results ?? []
}

function runWrangler(exec: Run, args: string[]): string {
	const { code, stderr, stdout } = exec("wrangler", args)
	if (code !== 0) {
		throw new Error(`wrangler failed (exit ${code}): ${stderr.trim() || stdout.trim()}`)
	}
	return stdout
}

/**
 * Inline `?` placeholders with SQL literals. The wrangler d1 execute CLI only accepts raw SQL via
 * --command, with no parameter binding surface, so the driver interpolates before shelling out.
 * Only a `?` in code is a placeholder; one inside a literal or a comment is text.
 */
function inlineParams(sql: string, params: unknown[]): string {
	let i = 0
	const fill = () => {
		if (i >= params.length) throw new Error("Not enough params for SQL placeholders")
		return formatLiteral(params[i++])
	}
	return segments(sql)
		.map((segment) => (segment.kind === "code" ? segment.text.replace(/\?/g, fill) : segment.text))
		.join("")
}

/**
 * One batch statement ready to be followed by the next: an unterminated block comment closed, and
 * the `;` on a line of its own, so a trailing `--` comment cannot swallow it.
 */
function terminated(sql: string): string {
	const last = segments(sql).at(-1)
	const open = last?.kind === "comment" && last.text.startsWith("/*") && !last.text.endsWith("*/")
	return `${sql}${open ? " */" : ""}\n;`
}

function formatLiteral(value: unknown): string {
	if (value === null || value === undefined) return "NULL"
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`Invalid numeric literal: ${value}`)
		return String(value)
	}
	if (typeof value === "bigint") return String(value)
	if (typeof value === "boolean") return value ? "1" : "0"
	if (value instanceof Date) return String(value.getTime())
	if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`
	throw new Error(`Unsupported SQL literal: ${typeof value}`)
}

function createD1Connection(databaseName: string, target: "--local" | "--remote", exec: Run): Connection {
	return {
		async batch(statements: Array<{ sql: string }>): Promise<void> {
			const sql = statements.map((s) => terminated(s.sql)).join("\n")
			const dir = mkdtempSync(join(tmpdir(), "comb-d1-batch-"))
			const tmpFile = join(dir, "batch.sql")
			try {
				writeFileSync(tmpFile, sql)
				runWrangler(exec, ["d1", "execute", databaseName, target, `--file=${tmpFile}`])
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		},

		close(): Promise<void> {
			return Promise.resolve()
		},
		dialect: "sqlite",

		async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
			const finalSql = params && params.length > 0 ? inlineParams(sql, params) : sql
			const stdout = runWrangler(exec, ["d1", "execute", databaseName, target, "--json", `--command=${finalSql}`])
			const results = readResults(stdout)
			/* wrangler names the columns on every row; an empty result has none */
			const columns = Object.keys(results[0] ?? {})
			return {
				columns,
				rows: results.map((row) => columns.map((col) => row[col])),
			}
		},
	}
}

export function createD1Provider(config: D1ProviderConfig, exec: Run = run): ConnectionProvider {
	const target = config.local === true ? "--local" : "--remote"
	return {
		connect(dbConfig: ResolvedDatabaseConfig): Promise<Connection> {
			/* Use resolved env name (e.g. csvme-core-local) so each env targets its own D1 db */
			return Promise.resolve(createD1Connection(dbConfig.name, target, exec))
		},
		dialect: "sqlite",
	}
}
