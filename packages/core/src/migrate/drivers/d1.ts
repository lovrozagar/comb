/**
 * Cloudflare D1 driver — shells out to `wrangler d1 execute`
 * since D1 has no HTTP API for external access.
 */
import * as z from "zod"
import { hold } from "../core/cleanup.ts"
import { findWranglerConfig, localHeld, wranglerReader } from "../core/d1-binding.ts"
import { projectBin } from "../core/optional-peer.ts"
import { WRANGLER } from "../core/peer-needs.ts"
import { type ProjectBin, type Run, run, runPeer } from "../core/process.ts"
import { segments } from "../../sql-lexer.ts"
import { LOCAL_LOCK_MS, LOCKER, lockedOut } from "./d1-lock.ts"
import type { Connection, ConnectionProvider, D1ProviderConfig, QueryResult } from "../types.ts"

/* wrangler JSON output schema for query results, built on use: each command parses it once */
const wranglerResultSchema = () =>
	z.array(z.object({ results: z.array(z.record(z.string(), z.unknown())).default([]) }))

/** Each statement's rows from `wrangler d1 execute --json`; output of any other shape is an error, never "no rows" */
function readAllResults(stdout: string): Array<Array<Record<string, unknown>>> {
	let json: unknown
	try {
		json = JSON.parse(stdout)
	} catch {
		throw new Error(`wrangler printed output that is not JSON: ${stdout.trim().slice(0, 200)}`)
	}
	const parsed = wranglerResultSchema().safeParse(json)
	if (!parsed.success) throw new Error(`wrangler printed JSON comb cannot read: ${stdout.trim().slice(0, 200)}`)
	return parsed.data.map((result) => result.results)
}

/** The first statement's rows of `wrangler d1 execute --json` */
const readResults = (stdout: string): Array<Record<string, unknown>> => readAllResults(stdout)[0] ?? []

/** Rows as a QueryResult: wrangler names the columns on every row, and an empty result has none */
function asQueryResult(results: Array<Record<string, unknown>>): QueryResult {
	const columns = Object.keys(results[0] ?? {})
	return { columns, rows: results.map((row) => columns.map((col) => row[col])) }
}

/**
 * wrangler as the D1 commands run it: the project's bin, the one comb checked, through `exec` (K1 of r22), and
 * whether another process holds the local database's write lock now (d1-lock.ts lockedOut)
 */
type Wrangler = { exec: Run; held: () => Promise<boolean>; wrangler: ProjectBin }

/** Whether `ms` ran out (true), or a signal stopped comb first (its name), after which nothing new starts */
function waitOut(ms: number): Promise<true | NodeJS.Signals> {
	return new Promise((resolve) => {
		const release = hold(async (signal) => {
			clearTimeout(timer)
			resolve(signal)
		})
		const timer = setTimeout(() => {
			release()
			resolve(true)
		}, ms)
	})
}

/**
 * `args` run by wrangler, its stdout once it exits 0. A --local command another process's lock on the file
 * made fail runs again, after a backoff, until LOCAL_LOCK_MS have passed since the first failure it met (a cold
 * start can outlast the whole window, so the window starts at the lock, not the start): wrangler sends each --command as
 * one request, and miniflare runs each request in one transaction (transactionSync), so the request a held
 * lock failed made no change, and running it again runs it once. Even a read takes the write lock there, and
 * a command cannot set busy_timeout (SQLITE_AUTH), so the wait is comb's. Whether a run met the lock is
 * workerd's SQLITE_BUSY in its output or, since a run can end before workerd's line is forwarded, SQLite's own
 * answer for the file (d1-lock.ts lockedOut). A remote command runs once.
 */
async function runWrangler({ exec, held, wrangler }: Wrangler, args: string[]): Promise<string> {
	let deadline: number | undefined
	for (let delay = 100; ; delay *= 2) {
		const ran = await runPeer(exec, wrangler)(args)
		const { code, stderr, stdout } = ran
		if (code === 0) return stdout
		const failed = `wrangler failed (exit ${code})`
		if (!args.includes("--local") || !(await lockedOut(ran, held)))
			throw new Error(`${failed}: ${stderr.trim() || stdout.trim()}`)
		deadline ??= Date.now() + LOCAL_LOCK_MS
		const left = deadline - Date.now()
		if (left <= 0)
			throw new Error(`${failed}: the local D1 database stayed locked by ${LOCKER} for 5 s: let it finish and rerun`)
		const waited = await waitOut(Math.min(delay, left))
		if (waited !== true)
			throw new Error(`${failed}: comb stopped (${waited}) while the local D1 database was locked by another process`)
	}
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

/** What every wrangler command on the database takes: --local or --remote, then its config and environment */
function wranglerFlags(config: D1ProviderConfig): string[] {
	return [
		config.local === true ? "--local" : "--remote",
		...(config.wranglerConfig === undefined ? [] : ["--config", config.wranglerConfig]),
		...(config.wranglerEnv === undefined ? [] : ["--env", config.wranglerEnv]),
	]
}

/* the longest --command a batch sends: Linux refuses one argument past MAX_ARG_STRLEN, 128 KiB, and
   macOS the whole argv and environment past 1 MiB */
const COMMAND_BYTES = 100 * 1024

/**
 * `statements` in order, as the fewest runs of consecutive statements that each fit one --command.
 * --command goes through D1's query API; a remote --file goes through its import API, which takes the
 * database out of service while it ingests (S8 of the 0.15.0 review), so a long batch is split, never
 * written to a file (S4 of r18). wrangler runs no --command as one transaction either.
 */
function commands(statements: readonly string[]): string[] {
	const out: string[] = []
	let chunk = ""
	for (const statement of statements) {
		const bytes = Buffer.byteLength(statement)
		if (bytes > COMMAND_BYTES) {
			throw new Error(
				`a batch statement of ${bytes} bytes is longer than one wrangler argument takes (${COMMAND_BYTES}): ${statement.slice(0, 80)}`,
			)
		}
		if (chunk !== "" && Buffer.byteLength(chunk) + 1 + bytes > COMMAND_BYTES) {
			out.push(chunk)
			chunk = ""
		}
		chunk = chunk === "" ? statement : `${chunk}\n${statement}`
	}
	return chunk === "" ? out : [...out, chunk]
}

function createD1Connection(databaseName: string, flags: readonly string[], spawn: Wrangler): Connection {
	return {
		async batch(statements: Array<{ sql: string; params?: unknown[] | undefined }>): Promise<void> {
			/* wrangler binds no parameters in a batch, so they are inlined as literals */
			const sql = statements.map(({ params, sql: text }) =>
				terminated(params && params.length > 0 ? inlineParams(text, params) : text),
			)
			for (const command of commands(sql))
				await runWrangler(spawn, ["d1", "execute", databaseName, ...flags, `--command=${command}`])
		},

		close(): Promise<void> {
			return Promise.resolve()
		},
		dialect: "sqlite",
		/* D1 keeps _cf_ tables of its own, which refuse even a read of their schema */
		ownedPrefix: "_cf_",

		async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
			const finalSql = params && params.length > 0 ? inlineParams(sql, params) : sql
			const stdout = await runWrangler(spawn, [
				"d1",
				"execute",
				databaseName,
				...flags,
				"--json",
				`--command=${finalSql}`,
			])
			return asQueryResult(readResults(stdout))
		},
	}
}

/**
 * Each of `statements`' rows from one `wrangler d1 execute --json --command`, one wrangler process
 * for them all: wrangler answers a result per statement, and one that fails fails the call (R1)
 */
async function executeAll(
	exec: Run,
	{ flags, held, name, wrangler }: Omit<Wrangler, "exec"> & { flags: readonly string[]; name: string },
	statements: readonly string[],
): Promise<Array<Array<Record<string, unknown>>>> {
	const args = ["d1", "execute", name, ...flags, "--json", `--command=${statements.join(";\n")}`]
	const stdout = await runWrangler({ exec, held, wrangler }, args)
	const results = readAllResults(stdout)
	if (results.length !== statements.length)
		throw new Error(`wrangler answered ${results.length} results for ${statements.length} statements`)
	return results
}

export { executeAll, wranglerFlags }

/**
 * The connection to the D1 database `config` names, through `wrangler`, the bin the command
 * resolved: the D1 database is the provider's databaseName (its binding or database_name), never
 * the environment's name the resolved config carries, which wrangler knows nothing of (K4 of r17)
 */
export function connectD1(config: D1ProviderConfig, spawn: Wrangler): Connection {
	return createD1Connection(config.databaseName, wranglerFlags(config), spawn)
}

/**
 * A D1 provider whose connection runs the wrangler the project at the working folder holds, checked on connect;
 * its local file is the one the config names, or else the one wrangler finds in the working folder
 */
export function createD1Provider(config: D1ProviderConfig, exec: Run = run): ConnectionProvider {
	return {
		connect(): Promise<Connection> {
			return Promise.resolve().then(() => {
				const wrangler = projectBin(WRANGLER, process.cwd())
				const held = localHeld(() => wranglerReader(wrangler), {
					name: config.databaseName,
					wranglerConfig: config.wranglerConfig ?? findWranglerConfig(process.cwd()),
					wranglerEnv: config.wranglerEnv,
				})
				return connectD1(config, { exec, held, wrangler })
			})
		},
		dialect: "sqlite",
	}
}
