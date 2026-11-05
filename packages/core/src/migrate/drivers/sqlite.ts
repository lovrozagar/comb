/**
 * SQLite driver implementations (Turso, libsql), and SQLite schema introspection. The bun:sqlite
 * driver lives in bun-sqlite.ts, the one file Bun's APIs may appear in.
 */
import * as z from "zod"
import { chainText } from "../../error-chain.ts"
import type {
	Connection,
	ConnectionProvider,
	LibsqlProviderConfig,
	QueryResult,
	ResolvedDatabaseConfig,
	TursoProviderConfig,
} from "../types.ts"
import { BUSY_TIMEOUT } from "../core/apply.ts"
import { pastStop } from "../core/cleanup.ts"
import { type Client, type InValue, libsql } from "./libsql-client.ts"
import { openFileDatabase } from "./file-open.ts"
import { DatabaseMissing } from "./missing.ts"

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
	/** what the Platform API calls go through; default: the global fetch */
	fetch?: typeof fetch | undefined
	/** A progress line, such as the database being created; no output when omitted */
	log?: ((line: string) => void) | undefined
}

/** The Turso database `getTursoCredentials` fetches the credentials of, and how */
export type TursoCredentialsRequest = TursoDeps & {
	/** a Turso Platform API token, which may list, create and mint tokens for the org's databases */
	apiToken: string
	/** the database's name in the org */
	dbName: string
	/** The placement group a database created on demand joins (default "default") */
	group?: string | undefined
	/** the Turso organization the database belongs to */
	org: string
	/** a reader's credentials: a missing database is an error, not created, and the token is read-only */
	readonly?: boolean | undefined
}

/** A reader found no Turso database `name` (`org/db`): a reader creates none */
export class TursoMissing extends DatabaseMissing {
	/** an error naming the database `name`, as `org/db` */
	constructor(name: string) {
		super(`Turso database "${name}" does not exist; check and status create none`)
		this.name = "TursoMissing"
	}
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

/** `call`, its failure to reach the API at all said with each cause under it, as `fetch failed: connect ECONNREFUSED …` (S2 of r21) */
const reaching = (call: typeof fetch, name: string): typeof fetch =>
	((...args: Parameters<typeof fetch>) =>
		call(...args).catch((error: unknown) => {
			throw new Error(`comb could not reach the Turso API for "${name}": ${chainText(error)}`, { cause: error })
		})) as typeof fetch

/**
 * The libsql URL and a one-hour token for a Turso database, creating the database when it is
 * missing; for a reader, a read-only token, and a missing database is an error. Turso reads the
 * token's expiration and authorization from the query (a body is ignored, and the default never expires).
 */
export async function getTursoCredentials(request: TursoCredentialsRequest): Promise<{
	/** the database's `libsql://` URL */
	url: string
	/** a token for it that expires in an hour, read-only for a reader */
	authToken: string
}> {
	const { apiToken, dbName, org } = request
	const call = reaching(request.fetch ?? fetch, `${org}/${dbName}`)
	const baseUrl = `https://api.turso.tech/v1/organizations/${org}/databases/${dbName}`
	const headers = { Authorization: `Bearer ${apiToken}` }

	let dbRes = await call(baseUrl, { headers })
	if (dbRes.status === 404 && request.readonly === true) throw new TursoMissing(`${org}/${dbName}`)
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
		async batch(statements: Array<{ sql: string; params?: unknown[] | undefined }>): Promise<void> {
			const batch = statements.map(({ params, sql }) => ({ args: (params ?? []) as InValue[], sql }))
			/* "write" begins it IMMEDIATE: the write lock is taken, or waited for, before any statement (SL4 of r22) */
			await client.batch(batch, "write")
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

// S1 of r21
/**
 * A Turso database's provider. Each connect opens a new client, so each migration file has a
 * connection of its own; the credentials are fetched once per provider for a reader and once for a
 * writer, so a command mints one token of each kind it needs, however many files it applies. A
 * writer's connect creates the database when it is missing; a reader's throws `TursoMissing`. Needs
 * `@libsql/client` installed
 */
export function createTursoProvider(config: TursoProviderConfig, deps: TursoDeps = {}): ConnectionProvider {
	const minted = new Map<boolean, Promise<{ authToken: string; url: string }>>()
	const credentials = (readonly: boolean) => {
		const { apiToken, databaseName, group, org } = config
		const known =
			minted.get(readonly) ?? getTursoCredentials({ ...deps, apiToken, dbName: databaseName, group, org, readonly })
		minted.set(readonly, known)
		return known
	}
	return {
		async connect(dbConfig: ResolvedDatabaseConfig): Promise<Connection> {
			await pastStop()
			/* the client first: a project without it is refused before Turso creates a database or mints a token (S2 of r21) */
			const { createClient } = await libsql()
			const creds = await credentials(dbConfig.readonly === true)
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

/**
 * A libsql database's provider, by URL: a `file:` path, `:memory:`, or a libsql server. A file is
 * created when missing, except by a reader, which throws `DatabaseMissing`, and waits up to 5 s for
 * a lock another process holds. Needs `@libsql/client` installed
 */
export function createLibsqlProvider(config: LibsqlProviderConfig): ConnectionProvider {
	return {
		async connect(dbConfig?: ResolvedDatabaseConfig): Promise<Connection> {
			await pastStop()
			const file = libsqlFile(config.url)
			const { createClient } = await libsql()
			/* `Config` from @libsql/client admits no explicit undefined, so the key is left out */
			const open = () =>
				createClient({ ...(config.authToken === undefined ? {} : { authToken: config.authToken }), url: config.url })
			if (file === undefined || file === ":memory:") return createLibsqlConnection(open())
			/* libsql has no read-only mode for a file, and creates a missing one; a file waits for a lock another process holds (SL4 of r22) */
			const client = await openFileDatabase(file, dbConfig?.readonly === true, async () => {
				const opened = open()
				await opened.execute({ args: [], sql: BUSY_TIMEOUT })
				return opened
			})
			return createLibsqlConnection(client)
		},
		dialect: "sqlite",
	}
}
