import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseUri } from "@libsql/core/uri"
import { describe, expect, it, vi } from "vitest"
import { openedWhileStopping } from "../../../tests/support/signals.ts"
import {
	createBunSqliteProvider,
	createLibsqlProvider,
	createTursoProvider,
	getTursoCredentials,
	libsqlFile,
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

/* r22b: a connection is new work, which a stopping run starts none of */
describe("provider factories while a signal's stop runs", () => {
	it("connects to libsql only once the stop is past", async () => {
		const provider = createLibsqlProvider({ type: "libsql", url: ":memory:" })
		const { early, value } = await openedWhileStopping(() =>
			provider.connect({ migrationsDir: "m", name: "local", provider: { type: "libsql", url: ":memory:" } }),
		)
		await value.close()
		expect(early).toBe(false)
	})

	it("asks Turso for nothing until the stop is past", async () => {
		const api = fakeTurso([DB_INFO, TOKEN])
		const turso = { apiToken: "tok", databaseName: "core", group: "default", org: "acme", type: "turso" } as const
		const provider = createTursoProvider(turso, { fetch: api.fetch })
		const { early, value } = await openedWhileStopping(() =>
			provider.connect({ migrationsDir: "m", name: "prod", provider: turso }),
		)
		await value.close()
		expect(early).toBe(false)
	})
})

describe("provider factories", () => {
	/* r18 K2: the provider names its database, never the environment's name, which defaults to its key */
	it("createTursoProvider connects with the credentials it fetched for the provider's databaseName", async () => {
		const api = fakeTurso([DB_INFO, TOKEN])
		const turso = { apiToken: "tok", databaseName: "core-prod", group: "default", org: "acme", type: "turso" } as const
		const provider = createTursoProvider(turso, { fetch: api.fetch })
		expect(provider.dialect).toBe("sqlite")
		const conn = await provider.connect({ migrationsDir: "m", name: "prod", provider: turso })
		expect(api.requests[0]?.url).toBe("https://api.turso.tech/v1/organizations/acme/databases/core-prod")
		await conn.close()
	})

	it("createTursoProvider uses the real fetch when none is injected", () => {
		expect(
			createTursoProvider({ apiToken: "tok", databaseName: "core", group: "default", org: "acme", type: "turso" })
				.dialect,
		).toBe("sqlite")
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

describe("createTursoProvider across a command's connections", () => {
	/* S1 of r21: a client per migration file, and one token of each kind per command */
	it("createTursoProvider opens a new client per connect, minting one token for the reader and one for the writer", async () => {
		const api = fakeTurso([DB_INFO, TOKEN, DB_INFO, [200, { jwt: "jwt-2" }]])
		const turso = { apiToken: "tok", databaseName: "core", group: "default", org: "acme", type: "turso" } as const
		const provider = createTursoProvider(turso, { fetch: api.fetch })
		const config = { migrationsDir: "m", name: "prod", provider: turso }
		const [reader, writer, again] = [
			await provider.connect({ ...config, readonly: true }),
			await provider.connect(config),
			await provider.connect(config),
		]
		expect(writer).not.toBe(again)
		expect(api.requests.map(({ url }) => url.split("?")[1] ?? "")).toEqual([
			"",
			"expiration=1h&authorization=read-only",
			"",
			"expiration=1h&authorization=full-access",
		])
		for (const conn of [reader, writer, again]) await conn.close()
	})
})

/* S2 of r21: the client loads before Turso's API is called, so a project without it creates and mints nothing */
describe("createTursoProvider before its API", () => {
	const turso = { apiToken: "tok", databaseName: "core", group: "default", org: "acme", type: "turso" } as const

	it.each([true, false])("makes no call without @libsql/client (readonly %s)", async (readonly) => {
		vi.doMock("@libsql/client", () => {
			throw new Error("Cannot find package '@libsql/client'")
		})
		vi.resetModules()
		try {
			const { createTursoProvider: missing } = await import("./sqlite.ts")
			const api = fakeTurso([[404, {}], DB_INFO, TOKEN])
			const connecting = missing(turso, { fetch: api.fetch }).connect({
				migrationsDir: "m",
				name: "core",
				provider: turso,
				readonly,
			})
			await expect(connecting).rejects.toMatchObject({ name: "MissingPeerError" })
			expect(api.requests).toEqual([])
		} finally {
			vi.doUnmock("@libsql/client")
		}
	})

	it("names the cause of an API it cannot reach", async () => {
		const refused = new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
		})
		const down = (() => Promise.reject(refused)) as unknown as typeof fetch
		const connecting = createTursoProvider(turso, { fetch: down }).connect({
			migrationsDir: "m",
			name: "core",
			provider: turso,
		})
		await expect(connecting).rejects.toThrow(
			'comb could not reach the Turso API for "acme/core": fetch failed: connect ECONNREFUSED 127.0.0.1:443',
		)
		await expect(connecting).rejects.toMatchObject({ cause: refused })
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
			{ apiToken: "tok", databaseName: "core", group: "default", org: "acme", type: "turso" },
			{ fetch: reader.fetch },
		)
		await expect(
			readOnly.connect({
				migrationsDir: "m",
				name: "typo-db",
				provider: { apiToken: "tok", databaseName: "core", group: "default", org: "acme", type: "turso" },
				readonly: true,
			}),
		).rejects.toThrow("does not exist")
	})
})

/* M18 of the 0.12 round: libsql reads a URL's scheme in any case, so the read-only guard does too */
describe("libsql for a reader (M18)", () => {
	it.each(["file:", "FILE:", "File://"])("refuses a missing file under %s, and creates none", async (scheme) => {
		const dir = mkdtempSync(join(tmpdir(), "comb-libsql-ro-"))
		const path = join(dir, "missing.db")
		const provider = { type: "libsql" as const, url: `${scheme}${path}` }
		await expect(
			createLibsqlProvider(provider).connect({ migrationsDir: "m", name: "core", provider, readonly: true }),
		).rejects.toThrow(`${path} does not exist; check and status open a database read-only, and create none`)
		expect(existsSync(path)).toBe(false)
		rmSync(dir, { force: true, recursive: true })
	})
})

/* AD7-8 of the area D round-seven review: the file connection check, status and API callers get waits out a lock */
describe("libsql on a file", () => {
	it.each([false, true])("waits up to 5 s for a lock another process holds, read-only %s", async (readonly) => {
		const dir = mkdtempSync(join(tmpdir(), "comb-libsql-busy-"))
		const path = join(dir, "a.db")
		writeFileSync(path, "")
		const provider = { type: "libsql" as const, url: `file:${path}` }
		const conn = await createLibsqlProvider(provider).connect({ migrationsDir: "m", name: "core", provider, readonly })
		const { rows } = await conn.execute("PRAGMA busy_timeout")
		await conn.close()
		rmSync(dir, { force: true, recursive: true })
		expect(rows).toEqual([[5000]])
	})
})

/* M80 of the 0.13.0 round: libsql percent-decodes a file: URL's path, so the read-only guard checks the path libsql opens */
/** A read-only libsql connection to `url`, as check and status open one */
function readOnlyAt(url: string) {
	const provider = { type: "libsql" as const, url }
	return createLibsqlProvider(provider).connect({ migrationsDir: "m", name: "core", provider, readonly: true })
}

describe("libsql for a reader, its file: path decoded as libsql reads it (M80)", () => {
	it("refuses a URL whose decoded file is missing beside a file named as the URL spells it, and creates none", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-libsql-m80-"))
		writeFileSync(join(dir, "a%20b.db"), "")
		await expect(readOnlyAt(`file:${dir}/a%20b.db`)).rejects.toThrow(
			`${join(dir, "a b.db")} does not exist; check and status open a database read-only, and create none`,
		)
		expect(readdirSync(dir)).toEqual(["a%20b.db"])
		rmSync(dir, { force: true, recursive: true })
	})

	it("opens a file a URL names percent-encoded, and creates nothing beside it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-libsql-m80-"))
		writeFileSync(join(dir, "x y.db"), "")
		const conn = await readOnlyAt(`file://${dir}/x%20y.db`)
		await conn.execute("SELECT 1")
		await conn.close()
		expect(readdirSync(dir)).toEqual(["x y.db"])
		rmSync(dir, { force: true, recursive: true })
	})

	it("leaves a path libsql cannot decode to libsql, which refuses it before opening anything", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-libsql-m80-"))
		await expect(readOnlyAt(`file:${dir}/bad%ZZ.db`)).rejects.toThrow(/percent encoding/)
		expect(readdirSync(dir)).toEqual([])
		rmSync(dir, { force: true, recursive: true })
	})
})

/* M80: libsqlFile mirrors @libsql/core's parseUri; pinned against it, so a libsql upgrade that reads a URL otherwise fails here */
describe("libsqlFile against @libsql/core's parseUri", () => {
	it("reads every URL of the corpus as parseUri does, and refuses what it refuses", () => {
		const corpus = [
			"file:a.db",
			"FILE:a.db",
			"File://x/a.db",
			"file:///tmp/a.db",
			"file://host/a.db",
			"file:a.db?mode=ro",
			"file:a.db#frag",
			"file:a.db?x=1#f",
			"file:a%20b.db",
			"file:100%25.db",
			"file:dir%2Fa.db",
			"file:%E2%82%AC.db",
			"file:bad%ZZ.db",
			"file::memory:",
			"libsql://db.example.com",
		]
		for (const url of corpus) {
			let expected: string | undefined
			try {
				const uri = parseUri(url)
				expected = uri.scheme.toLowerCase() === "file" ? uri.path : undefined
			} catch {
				expected = undefined
			}
			expect([url, libsqlFile(url)]).toEqual([url, expected])
		}
	})
})
