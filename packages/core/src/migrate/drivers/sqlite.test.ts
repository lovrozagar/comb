import { describe, expect, it, vi } from "vitest"
import { type LibsqlConnection, libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import {
	createBunSqliteProvider,
	createLibsqlProvider,
	createTursoProvider,
	getSqliteColumns,
	getSqliteIndexes,
	getSqliteTables,
	getTursoCredentials,
	introspectSqliteSchema,
} from "./sqlite.ts"

/** A fake Turso API: each call takes the next answer, and every request is kept */
function fakeTurso(answers: Array<[status: number, body: unknown]>) {
	const requests: Array<{ init: RequestInit | undefined; url: string }> = []
	const fake = ((url: string, init?: RequestInit) => {
		requests.push({ init, url })
		const [status, body] = answers.shift() ?? [500, "no answer left"]
		const text = typeof body === "string" ? body : JSON.stringify(body)
		return Promise.resolve(new Response(text, { status }))
	}) as typeof fetch
	return { fetch: fake, requests }
}

const DB_INFO: [number, unknown] = [200, { database: { Hostname: "core-acme.turso.io" } }]
const TOKEN: [number, unknown] = [200, { jwt: "jwt-1" }]
const REQUEST = { apiToken: "tok", dbName: "core", org: "acme" }

describe("getTursoCredentials", () => {
	it("returns the libsql URL and a token, quietly, for a database that exists", async () => {
		const lines: string[] = []
		const api = fakeTurso([DB_INFO, TOKEN])
		const creds = await getTursoCredentials({ ...REQUEST, fetch: api.fetch, log: (line) => lines.push(line) })
		expect(creds).toEqual({ authToken: "jwt-1", url: "libsql://core-acme.turso.io" })
		expect(api.requests.map((r) => r.url)).toEqual([
			"https://api.turso.tech/v1/organizations/acme/databases/core",
			"https://api.turso.tech/v1/organizations/acme/databases/core/auth/tokens?expiration=1h&authorization=full-access",
		])
		expect(lines).toEqual([])
	})

	it("creates a missing database in the default group and says so through log", async () => {
		const lines: string[] = []
		const api = fakeTurso([[404, {}], [200, {}], DB_INFO, TOKEN])
		await getTursoCredentials({ ...REQUEST, fetch: api.fetch, log: (line) => lines.push(line) })
		expect(JSON.parse(String(api.requests[1]?.init?.body))).toEqual({ group: "default", name: "core" })
		expect(lines).toEqual(['Database "core" not found — creating it in org acme, group default', 'Created "core"'])
	})

	it("calls the global fetch when none is injected", async () => {
		const api = fakeTurso([DB_INFO, TOKEN])
		vi.stubGlobal("fetch", api.fetch)
		try {
			expect((await getTursoCredentials(REQUEST)).authToken).toBe("jwt-1")
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("creates a missing database in the configured group, with no output when no log is given", async () => {
		const api = fakeTurso([[404, {}], [200, {}], DB_INFO, TOKEN])
		await getTursoCredentials({ ...REQUEST, fetch: api.fetch, group: "eu" })
		expect(JSON.parse(String(api.requests[1]?.init?.body))).toEqual({ group: "eu", name: "core" })
	})

	it.each([
		["the database lookup", [[500, { error: "boom" }]], 'Turso API error for "acme/core": boom'],
		[
			"creating the database",
			[
				[404, {}],
				[403, "<html>no</html>"],
			],
			'Failed to create Turso database "acme/core": HTTP 403',
		],
		["minting a token", [DB_INFO, [401, { error: 7 }]], 'Turso auth token error for "acme/core": HTTP 401'],
		["a JSON null error body", [[502, null]], 'Turso API error for "acme/core": HTTP 502'],
	] as Array<[string, Array<[number, unknown]>, string]>)("says why %s failed", async (_label, answers, message) => {
		await expect(getTursoCredentials({ ...REQUEST, fetch: fakeTurso(answers).fetch })).rejects.toThrow(message)
	})
})

describe("provider factories", () => {
	it("createTursoProvider connects with the credentials it fetched for the resolved database name", async () => {
		const api = fakeTurso([DB_INFO, TOKEN])
		const provider = createTursoProvider(
			{ apiToken: "tok", group: "default", org: "acme", type: "turso" },
			{ fetch: api.fetch },
		)
		expect(provider.dialect).toBe("sqlite")
		const conn = await provider.connect({
			migrationsDir: "m",
			name: "core-prod",
			provider: { apiToken: "tok", group: "default", org: "acme", type: "turso" },
		})
		expect(api.requests[0]?.url).toBe("https://api.turso.tech/v1/organizations/acme/databases/core-prod")
		await conn.close()
	})

	it("createTursoProvider uses the real fetch when none is injected", () => {
		expect(createTursoProvider({ apiToken: "tok", group: "default", org: "acme", type: "turso" }).dialect).toBe(
			"sqlite",
		)
	})

	it("createLibsqlProvider runs SQL on the database at its URL, with or without a token", async () => {
		for (const authToken of [undefined, "token"]) {
			const provider = createLibsqlProvider({ authToken, type: "libsql", url: ":memory:" })
			expect(provider.dialect).toBe("sqlite")
			const conn = await provider.connect({
				migrationsDir: "m",
				name: "x",
				provider: { type: "libsql", url: ":memory:" },
			})
			await conn.batch([{ sql: "CREATE TABLE t (a, b)" }, { params: [1, "x"], sql: "INSERT INTO t VALUES (?, ?)" }])
			await conn.batch([{ sql: "INSERT INTO t VALUES (2, 'y')" }])
			expect(await conn.execute("SELECT a, b FROM t WHERE a > ? ORDER BY a", [0])).toEqual({
				columns: ["a", "b"],
				rows: [
					[1, "x"],
					[2, "y"],
				],
			})
			expect((await conn.execute("SELECT count(*) AS n FROM t")).rows).toEqual([[2]])
			await conn.close()
		}
	})

	it("createBunSqliteProvider is re-exported from bun-sqlite.ts", () => {
		expect(createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).dialect).toBe("sqlite")
	})
})

/* introspection is SQL sqlite_master answers, so it runs on SQLite */
async function withSchema<T>(ddl: string, read: (conn: LibsqlConnection) => Promise<T>): Promise<T> {
	const conn = libsqlConnection()
	try {
		await conn.client.executeMultiple(ddl)
		return await read(conn)
	} finally {
		await conn.close()
	}
}

const USERS =
	"CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT); CREATE TABLE posts (id TEXT PRIMARY KEY); CREATE INDEX idx_users_email ON users(email);"

describe("introspectSqliteSchema", () => {
	it("returns sorted SQL from sqlite_master", async () => {
		const sql = await withSchema(USERS, introspectSqliteSchema)
		/* tables come before indexes */
		expect(sql.indexOf("CREATE TABLE")).toBeLessThan(sql.indexOf("CREATE INDEX"))
		expect(sql.endsWith(";")).toBe(true)
	})

	it("leaves out a spellfix1 index's shadow table and a view, keeping a plain trigger", async () => {
		const sql = await withSchema(
			"CREATE TABLE t (a); CREATE TABLE words_vocab (x); CREATE VIEW v AS SELECT 1; CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN SELECT 1; END;",
			introspectSqliteSchema,
		)
		expect(sql).toContain("words_vocab")
		expect(sql).toContain("t_ai")
		expect(sql).not.toContain("VIEW")
	})
})

describe("introspectSqliteSchema — FTS5 objects", () => {
	it("leaves out the virtual table, its shadow tables and the triggers writing into it, keeping others", async () => {
		const ddl = `CREATE TABLE p (id INTEGER PRIMARY KEY, a TEXT);
CREATE VIRTUAL TABLE p_fts USING fts5(a, content='p', content_rowid='id');
CREATE TRIGGER p_fts_ai AFTER INSERT ON p BEGIN INSERT INTO p_fts(rowid, a) VALUES (new.id, new.a); END;
CREATE TRIGGER p_log AFTER INSERT ON p BEGIN SELECT 1; END;`
		const sql = await withSchema(ddl, introspectSqliteSchema)
		expect(sql).toContain("p_log")
		expect(sql).not.toMatch(/p_fts/)
		expect((await withSchema(ddl, getSqliteTables)).sort()).toEqual(["p"])
	})
})

describe("getSqliteTables", () => {
	it("returns table names from sqlite_master", async () => {
		expect((await withSchema(USERS, getSqliteTables)).sort()).toEqual(["posts", "users"])
	})
})

describe("getSqliteColumns", () => {
	it("returns column names from PRAGMA table_info, for a table name that needs quoting too", async () => {
		expect(await withSchema(USERS, (conn) => getSqliteColumns(conn, "users"))).toEqual(["id", "email"])
		expect(
			await withSchema('CREATE TABLE "odd ""name" (a, b);', (conn) => getSqliteColumns(conn, 'odd "name')),
		).toEqual(["a", "b"])
	})
})

describe("getSqliteIndexes", () => {
	it("returns index names from sqlite_master", async () => {
		expect(await withSchema(USERS, getSqliteIndexes)).toEqual(["idx_users_email"])
	})
})

describe("Turso for a reader (M9)", () => {
	/* Turso reads both from the query: a body is ignored, and its default expiration is never */
	it("mints a read-only token, and creates nothing, for a reader (M9)", async () => {
		const api = fakeTurso([DB_INFO, TOKEN])
		await getTursoCredentials({ ...REQUEST, fetch: api.fetch, readonly: true })
		expect(api.requests[1]?.url).toBe(
			"https://api.turso.tech/v1/organizations/acme/databases/core/auth/tokens?expiration=1h&authorization=read-only",
		)
		const missing = fakeTurso([[404, {}]])
		await expect(getTursoCredentials({ ...REQUEST, fetch: missing.fetch, readonly: true })).rejects.toThrow(
			'Turso database "acme/core" does not exist; check and status create none',
		)
		expect(missing.requests).toHaveLength(1)
	})
	it("connects a reader without creating its database", async () => {
		const reader = fakeTurso([[404, {}]])
		const readOnly = createTursoProvider(
			{ apiToken: "tok", group: "default", org: "acme", type: "turso" },
			{ fetch: reader.fetch },
		)
		await expect(
			readOnly.connect({
				migrationsDir: "m",
				name: "typo-db",
				provider: { apiToken: "tok", group: "default", org: "acme", type: "turso" },
				readonly: true,
			}),
		).rejects.toThrow("does not exist")
	})
})
