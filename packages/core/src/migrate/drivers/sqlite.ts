/**
 * SQLite driver implementations (Turso, libsql), and SQLite schema introspection. The bun:sqlite
 * driver lives in bun-sqlite.ts, the one file Bun's APIs may appear in.
 */
import { existsSync } from "node:fs"
import type { Client, InValue } from "@libsql/client"
import * as z from "zod"
import type {
	Connection,
	ConnectionProvider,
	LibsqlProviderConfig,
	QueryResult,
	ResolvedDatabaseConfig,
	TursoProviderConfig,
} from "../types.ts"
import { HISTORY_TABLES, notEngineTables } from "../core/engine-tables.ts"

export { createBunSqliteProvider } from "./bun-sqlite.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   TURSO API SCHEMAS
   ═══════════════════════════════════════════════════════════════════════════ */

/* built on use: a migration command parses each Turso response once */
const tursoDbInfoSchema = () => z.object({ database: z.object({ Hostname: z.string().min(1) }) })

const tursoAuthTokenSchema = () => z.object({ jwt: z.string().min(1) })

/* ═══════════════════════════════════════════════════════════════════════════
   TURSO CREDENTIALS
   ═══════════════════════════════════════════════════════════════════════════ */

/** How the Turso calls reach the API and report progress: injectable, quiet by default */
export type TursoDeps = {
	fetch?: typeof fetch
	/** A progress line, such as the database being created; no output when omitted */
	log?: (line: string) => void
}

export type TursoCredentialsRequest = TursoDeps & {
	apiToken: string
	dbName: string
	/** The placement group a database created on demand joins (default "default") */
	group?: string | undefined
	org: string
	/** a reader's credentials: a missing database is an error, not created, and the token is read-only */
	readonly?: boolean | undefined
}

/** Turso's error message from a failed response, or the HTTP status when its body has none */
async function failure(res: Response): Promise<string> {
	const text = await res.text()
	try {
		const body = JSON.parse(text) as Record<string, unknown> | null
		if (typeof body?.["error"] === "string") return body["error"]
	} catch {
		// reason: an error body that is not JSON carries no message; the status still says what failed
	}
	return `HTTP ${res.status}`
}

async function createTursoDatabase(
	request: TursoCredentialsRequest & { fetch: typeof fetch; group: string },
): Promise<void> {
	const { apiToken, dbName, group, org } = request
	const log = request.log ?? (() => undefined)
	log(`Database "${dbName}" not found — creating it in org ${org}, group ${group}`)
	const res = await request.fetch(`https://api.turso.tech/v1/organizations/${org}/databases`, {
		body: JSON.stringify({ group, name: dbName }),
		headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
		method: "POST",
	})
	if (!res.ok) throw new Error(`Failed to create Turso database "${org}/${dbName}": ${await failure(res)}`)
	log(`Created "${dbName}"`)
}

/**
 * The libsql URL and a one-hour token for a Turso database, creating the database when it is
 * missing; for a reader, a read-only token, and a missing database is an error. Turso reads the
 * token's expiration and authorization from the query (a body is ignored, and the default never expires).
 */
export async function getTursoCredentials(
	request: TursoCredentialsRequest,
): Promise<{ url: string; authToken: string }> {
	const { apiToken, dbName, org } = request
	const call = request.fetch ?? fetch
	const baseUrl = `https://api.turso.tech/v1/organizations/${org}/databases/${dbName}`
	const headers = { Authorization: `Bearer ${apiToken}` }

	let dbRes = await call(baseUrl, { headers })
	if (dbRes.status === 404 && request.readonly === true)
		throw new Error(`Turso database "${org}/${dbName}" does not exist; check and status create none`)
	if (dbRes.status === 404) {
		await createTursoDatabase({ ...request, fetch: call, group: request.group ?? "default" })
		dbRes = await call(baseUrl, { headers })
	}
	if (!dbRes.ok) throw new Error(`Turso API error for "${org}/${dbName}": ${await failure(dbRes)}`)
	const dbInfo = tursoDbInfoSchema().parse(await dbRes.json())

	const authorization = request.readonly === true ? "read-only" : "full-access"
	const tokenRes = await call(`${baseUrl}/auth/tokens?expiration=1h&authorization=${authorization}`, {
		headers,
		method: "POST",
	})
	if (!tokenRes.ok) throw new Error(`Turso auth token error for "${org}/${dbName}": ${await failure(tokenRes)}`)
	const tokenData = tursoAuthTokenSchema().parse(await tokenRes.json())

	return { authToken: tokenData.jwt, url: `libsql://${dbInfo.database.Hostname}` }
}

/* ═══════════════════════════════════════════════════════════════════════════
   LIBSQL CONNECTION WRAPPER
   ═══════════════════════════════════════════════════════════════════════════ */

function createLibsqlConnection(client: Client): Connection {
	return {
		async batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
			await client.batch(
				statements.map((stmt) => ({
					args: (stmt.params ?? []) as InValue[],
					sql: stmt.sql,
				})),
			)
		},

		close(): Promise<void> {
			client.close()
			return Promise.resolve()
		},
		dialect: "sqlite",

		async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
			const args = (params ?? []) as InValue[]
			const result = await client.execute({ args, sql })
			return {
				columns: result.columns,
				rows: result.rows.map((row) => result.columns.map((col) => row[col])),
			}
		},
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   TURSO PROVIDER
   ═══════════════════════════════════════════════════════════════════════════ */

export function createTursoProvider(config: TursoProviderConfig, deps: TursoDeps = {}): ConnectionProvider {
	return {
		async connect(dbConfig: ResolvedDatabaseConfig): Promise<Connection> {
			const { apiToken, group, org } = config
			const creds = await getTursoCredentials({
				...deps,
				apiToken,
				dbName: dbConfig.name,
				group,
				org,
				readonly: dbConfig.readonly,
			})
			const { createClient } = await import("@libsql/client")
			const client = createClient({ authToken: creds.authToken, url: creds.url })
			return createLibsqlConnection(client)
		},
		dialect: "sqlite",
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   LIBSQL PROVIDER (direct connection string)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The file a libsql `file:` URL opens, read as @libsql/core's parseUri reads it (M80): the scheme in
 * any case, an optional `//authority`, and the path up to `?` or `#`, percent-decoded. Undefined for
 * another scheme, or a path libsql itself refuses to decode.
 */
export function libsqlFile(url: string): string | undefined {
	const [, scheme, path] = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/[^/?#]*)?([^?#]*)/su.exec(url) ?? []
	if (scheme?.toLowerCase() !== "file" || path === undefined) return undefined
	try {
		return decodeURIComponent(path)
	} catch {
		// reason: libsql refuses a path it cannot decode before it opens any file, so there is none to guard
		return undefined
	}
}

export function createLibsqlProvider(config: LibsqlProviderConfig): ConnectionProvider {
	return {
		async connect(dbConfig?: ResolvedDatabaseConfig): Promise<Connection> {
			/* libsql has no read-only mode for a file, and creates a missing one on connect */
			const file = libsqlFile(config.url)
			if (dbConfig?.readonly === true && file !== undefined && file !== ":memory:" && !existsSync(file))
				throw new Error(`${file} does not exist; check and status open a database read-only, and create none`)
			const { createClient } = await import("@libsql/client")
			/* `Config` from @libsql/client does not admit an explicit undefined, so omit
			   the key rather than pass one. */
			const client = createClient({
				...(config.authToken === undefined ? {} : { authToken: config.authToken }),
				url: config.url,
			})
			return createLibsqlConnection(client)
		},
		dialect: "sqlite",
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   SQLITE SCHEMA INTROSPECTION
   ═══════════════════════════════════════════════════════════════════════════ */

type MasterRow = { name: string; sql: string; type: string }

/* only SQLite's own autoindexes, filtered above, have no sql */
const DEFINED = "sql IS NOT NULL"

// lookup-table: the shadow tables each search module creates beside its virtual table
const SHADOWS: Readonly<Record<string, readonly string[]>> = {
	fts5: ["config", "content", "data", "docsize", "idx"],
	spellfix1: ["vocab"],
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Whether a row belongs to an FTS5 or spellfix1 index: the virtual table, its shadow tables, or a
 * trigger that writes into it. Matched by what the objects are, never by a name's suffix.
 */
function searchIndexObjects(rows: readonly MasterRow[]): (row: MasterRow) => boolean {
	const owned = new Set<string>()
	const virtual: string[] = []
	for (const row of rows) {
		const module = /\bUSING\s+(fts5|spellfix1)\b/i.exec(row.sql)?.[1]?.toLowerCase()
		if (row.type !== "table" || module === undefined) continue
		virtual.push(row.name)
		owned.add(row.name)
		for (const shadow of SHADOWS[module] as readonly string[]) owned.add(`${row.name}_${shadow}`)
	}
	const writesInto = (sql: string) =>
		virtual.some((name) => new RegExp(`\\bINTO\\s+[\x60"\\[]?${escapeRegExp(name)}\\b`, "i").test(sql))
	return (row) => owned.has(row.name) || (row.type === "trigger" && writesInto(row.sql))
}

/** The schema objects comb manages: everything but SQLite's own, Litestream's and search indexes */
async function managedObjects(conn: Connection): Promise<MasterRow[]> {
	const result = await conn.execute(
		`SELECT type, name, sql FROM sqlite_master WHERE ${DEFINED}${notEngineTables(conn, HISTORY_TABLES)}`,
	)
	const rows = result.rows.map(([type, name, sql]) => ({
		name: name as string,
		sql: sql as string,
		type: type as string,
	}))
	const searchIndex = searchIndexObjects(rows)
	return rows.filter((row) => !searchIndex(row))
}

export async function introspectSqliteSchema(conn: Connection): Promise<string> {
	const typeOrder: Record<string, number> = { index: 2, table: 1, trigger: 3 }
	const sorted = (await managedObjects(conn))
		.filter((row) => row.sql && Object.hasOwn(typeOrder, row.type))
		.sort((a, b) => (typeOrder[a.type] as number) - (typeOrder[b.type] as number))
	return `${sorted.map((row) => row.sql).join(";\n\n")};`
}

export async function getSqliteTables(conn: Connection): Promise<string[]> {
	return (await managedObjects(conn)).filter((row) => row.type === "table").map((row) => row.name)
}

export async function getSqliteColumns(conn: Connection, table: string): Promise<string[]> {
	const result = await conn.execute(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
	return result.rows.map((row) => row[1] as string)
}

export async function getSqliteIndexes(conn: Connection): Promise<string[]> {
	return (await managedObjects(conn)).filter((row) => row.type === "index").map((row) => row.name)
}
