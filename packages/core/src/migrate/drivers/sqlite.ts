/// <reference types="bun-types" />
/**
 * SQLite driver implementations (Turso, libsql, bun:sqlite)
 */
import type { Client, InValue } from "@libsql/client"
import * as z from "zod"
import type {
	BunSqliteProviderConfig,
	Connection,
	ConnectionProvider,
	LibsqlProviderConfig,
	QueryResult,
	ResolvedDatabaseConfig,
	TursoProviderConfig,
} from "../types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   TURSO API SCHEMAS
   ═══════════════════════════════════════════════════════════════════════════ */

const tursoDbInfoSchema = z.object({
	database: z.object({ Hostname: z.string().min(1) }),
})

const tursoAuthTokenSchema = z.object({ jwt: z.string().min(1) })

/* ═══════════════════════════════════════════════════════════════════════════
   TURSO CREDENTIALS
   ═══════════════════════════════════════════════════════════════════════════ */

async function createTursoDatabase(org: string, dbName: string, apiToken: string, group: string): Promise<void> {
	console.log(`\n⚠ Database "${dbName}" not found — creating new database`)
	console.log(`  org: ${org}  group: ${group}`)
	const res = await fetch(`https://api.turso.tech/v1/organizations/${org}/databases`, {
		body: JSON.stringify({ group, name: dbName }),
		headers: {
			Authorization: `Bearer ${apiToken}`,
			"Content-Type": "application/json",
		},
		method: "POST",
	})
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
		const msg = typeof body["error"] === "string" ? body["error"] : `HTTP ${res.status}`
		throw new Error(`Failed to create Turso database "${org}/${dbName}": ${msg}`)
	}
	console.log(`  ✓ Created "${dbName}"\n`)
}

export async function getTursoCredentials(
	org: string,
	dbName: string,
	apiToken: string,
	group = "default",
): Promise<{ url: string; authToken: string }> {
	const baseUrl = `https://api.turso.tech/v1/organizations/${org}/databases/${dbName}`
	const headers = { Authorization: `Bearer ${apiToken}` }

	let dbRes = await fetch(baseUrl, { headers })

	/* Auto-create database if it doesn't exist */
	if (dbRes.status === 404) {
		await createTursoDatabase(org, dbName, apiToken, group)
		dbRes = await fetch(baseUrl, { headers })
	}

	if (!dbRes.ok) {
		const body = (await dbRes.json().catch(() => ({}))) as Record<string, unknown>
		const msg = typeof body["error"] === "string" ? body["error"] : `HTTP ${dbRes.status}`
		throw new Error(`Turso API error for "${org}/${dbName}": ${msg}`)
	}

	const dbInfo = tursoDbInfoSchema.parse(await dbRes.json())

	const tokenRes = await fetch(`${baseUrl}/auth/tokens`, {
		body: JSON.stringify({ expiration: "1h" }),
		headers: { ...headers, "Content-Type": "application/json" },
		method: "POST",
	})
	if (!tokenRes.ok) {
		const body = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>
		const msg = typeof body["error"] === "string" ? body["error"] : `HTTP ${tokenRes.status}`
		throw new Error(`Turso auth token error for "${org}/${dbName}": ${msg}`)
	}

	const tokenData = tursoAuthTokenSchema.parse(await tokenRes.json())

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

export function createTursoProvider(config: TursoProviderConfig): ConnectionProvider {
	return {
		async connect(dbConfig: ResolvedDatabaseConfig): Promise<Connection> {
			const creds = await getTursoCredentials(config.org, dbConfig.name, config.apiToken, config.group)
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

export function createLibsqlProvider(config: LibsqlProviderConfig): ConnectionProvider {
	return {
		async connect(_dbConfig: ResolvedDatabaseConfig): Promise<Connection> {
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
   BUN:SQLITE PROVIDER
   ═══════════════════════════════════════════════════════════════════════════ */

export function createBunSqliteProvider(config: BunSqliteProviderConfig): ConnectionProvider {
	return {
		async connect(_dbConfig: ResolvedDatabaseConfig): Promise<Connection> {
			/* Dynamic import to avoid bundling bun:sqlite in non-bun environments */
			const bunSqlite = await import("bun:sqlite")
			const db = new bunSqlite.Database(config.path)

			type SqliteParam = string | number | bigint | boolean | null | Uint8Array

			return {
				batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
					db.transaction(() => {
						for (const stmt of statements) {
							const args = stmt.params as SqliteParam[] | undefined
							if (args && args.length > 0) {
								db.run(stmt.sql, args)
							} else {
								db.run(stmt.sql)
							}
						}
					})()
					return Promise.resolve()
				},

				close(): Promise<void> {
					db.close()
					return Promise.resolve()
				},
				dialect: "sqlite",

				execute(sql: string, params?: unknown[]): Promise<QueryResult> {
					const stmt = db.prepare(sql)
					const args = (params ?? []) as SqliteParam[]
					const rows =
						args.length > 0
							? (stmt.all(...args) as Record<string, unknown>[])
							: (stmt.all() as Record<string, unknown>[])
					const firstRow = rows[0]
					const columns = firstRow ? Object.keys(firstRow) : []
					return Promise.resolve({
						columns,
						rows: rows.map((row) => columns.map((col) => row[col])),
					})
				},
			}
		},
		dialect: "sqlite",
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   SQLITE SCHEMA INTROSPECTION
   ═══════════════════════════════════════════════════════════════════════════ */

export async function introspectSqliteSchema(conn: Connection): Promise<string> {
	const result = await conn.execute(`
    SELECT type, sql FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger')
      AND sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_litestream_%'
      AND name != '__drizzle_migrations'
      AND sql NOT LIKE '%USING fts5%'
      AND sql NOT LIKE '%USING spellfix1%'
      AND name NOT LIKE '%Fts'
      AND name NOT LIKE '%Fts_%'
      AND name NOT LIKE '%Spellfix'
      AND name NOT LIKE '%Spellfix_%'
  `)

	const typeOrder: Record<string, number> = { index: 2, table: 1, trigger: 3 }
	const sorted = result.rows
		.map((row) => ({ sql: row[1] as string, type: row[0] as string }))
		.filter((r) => r.sql)
		.sort((a, b) => (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99))

	return `${sorted.map((r) => r.sql).join(";\n\n")};`
}

export async function getSqliteTables(conn: Connection): Promise<string[]> {
	const result = await conn.execute(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_litestream_%'
      AND name != '__drizzle_migrations'
  `)
	return result.rows.map((row) => row[0] as string)
}

export async function getSqliteColumns(conn: Connection, table: string): Promise<string[]> {
	const result = await conn.execute(`PRAGMA table_info(${table})`)
	return result.rows.map((row) => row[1] as string)
}

export async function getSqliteIndexes(conn: Connection): Promise<string[]> {
	const result = await conn.execute(`
    SELECT name FROM sqlite_master
    WHERE type = 'index'
      AND name NOT LIKE 'sqlite_%'
  `)
	return result.rows.map((row) => row[0] as string)
}
