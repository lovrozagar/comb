import { describe, expect, it, vi } from "vitest"
import { createBunSqliteProvider } from "../drivers/bun-sqlite.ts"
import { applyEach, applyRecorded, checkMigrationHash, ensureMigrationsTable, recordMigrationHash } from "./apply.ts"
import type { Connection } from "../types.ts"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { generateMigrationHash, legacyMigrationHash, migrationHashes } from "./parse.ts"
import { Refused } from "./refused.ts"

vi.mock("bun:sqlite", () => import("../__fixtures__/bun-sqlite-node.ts"))

function mockConnection(overrides: Partial<Connection> = {}): Connection {
	return {
		batch: vi.fn(() => Promise.resolve()),
		close: vi.fn(() => Promise.resolve()),
		dialect: "sqlite",
		execute: vi.fn(() => Promise.resolve({ columns: [], rows: [] })),
		...overrides,
	}
}

describe("ensureMigrationsTable", () => {
	it("executes CREATE TABLE IF NOT EXISTS", async () => {
		const conn = mockConnection()
		await ensureMigrationsTable(conn)
		expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS"))
	})

	it("passes a 0.12 history's failed rebuild on as it came when nothing over the history was moved", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			"CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, name TEXT);",
		)
		const failing: Connection = { ...conn, batch: () => Promise.reject(new Error("disk full")) }
		await expect(ensureMigrationsTable(failing)).rejects.toThrow(/^disk full$/)
	})
})

describe("checkMigrationHash", () => {
	it("returns true when hash exists", async () => {
		const conn = mockConnection({
			execute: vi.fn(() => Promise.resolve({ columns: ["hash"], rows: [["abc123"]] })),
		})
		expect(await checkMigrationHash(conn, "abc123")).toBe(true)
	})

	it("returns false when hash missing", async () => {
		const conn = mockConnection()
		expect(await checkMigrationHash(conn, "abc123")).toBe(false)
	})
})

describe("recordMigrationHash", () => {
	it("inserts hash with timestamp", async () => {
		const conn = mockConnection()
		await recordMigrationHash(conn, "abc123", "1_init.sql")
		expect(conn.execute).toHaveBeenCalledWith(
			expect.stringContaining("INSERT INTO __drizzle_migrations"),
			expect.arrayContaining(["abc123", "1_init.sql"]),
		)
	})

	it("leaves the name NULL when none is given, for the next apply to fill", async () => {
		const conn = mockConnection()
		await recordMigrationHash(conn, "abc123")
		expect(conn.execute).toHaveBeenCalledWith(expect.any(String), ["abc123", expect.any(Number), null])
	})
})

describe("checkMigrationHash — hashes recorded before 0.5.0 (S-13)", () => {
	it("finds a migration recorded under its legacy hash, so it is not applied again", async () => {
		const sql = "INSERT INTO t VALUES ('a -- b');\n-- applied before 0.5.0"
		const conn = libsqlConnection()
		try {
			await ensureMigrationsTable(conn)
			await recordMigrationHash(conn, legacyMigrationHash(sql), "1_legacy.sql")
			expect(generateMigrationHash(sql)).not.toBe(legacyMigrationHash(sql))
			expect(await checkMigrationHash(conn, migrationHashes(sql))).toBe(true)
			expect(await checkMigrationHash(conn, generateMigrationHash(sql))).toBe(false)
		} finally {
			await conn.close()
		}
	})
})

/*
 * S6 of the 0.14.1 review: a batch can commit and its answer still fail ("fetch failed"), and its
 * statements need not run twice safely; the history it wrote says it ran, so a retry reads that first
 */
describe("applyRecorded", () => {
	const migration = { filename: "1_a.sql", hash: "h1", statements: ["CREATE TABLE a (x)", "INSERT INTO a VALUES (1)"] }
	const NOW = { baseDelay: 0, maxDelay: 0 }

	it("runs a file's statements and its record once, a retry after a batch that committed running nothing", async () => {
		const conn = libsqlConnection()
		await ensureMigrationsTable(conn)
		let calls = 0
		const lost: Connection = {
			...conn,
			batch: async (statements) => {
				calls++
				await conn.batch(statements)
				if (calls === 1)
					throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })
			},
		}
		await applyRecorded(lost, migration, NOW)
		expect(calls).toBe(1)
		expect((await conn.execute("SELECT count(*) FROM a")).rows[0]?.[0]).toBe(1)
		expect((await conn.execute("SELECT name FROM __drizzle_migrations")).rows).toEqual([["1_a.sql"]])
	})

	it("retries a batch that failed before it committed, and passes on a failure that is not transient", async () => {
		const conn = libsqlConnection()
		await ensureMigrationsTable(conn)
		let calls = 0
		const flaky: Connection = {
			...conn,
			batch: async (statements) => {
				if (++calls === 1) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })
				await conn.batch(statements)
			},
		}
		await applyRecorded(flaky, migration, NOW)
		expect(calls).toBe(2)
		expect((await conn.execute("SELECT count(*) FROM a")).rows[0]?.[0]).toBe(1)
		const broken: Connection = { ...conn, batch: async () => Promise.reject(new Error("no such table: b")) }
		await expect(applyRecorded(broken, { ...migration, filename: "2_b.sql" }, NOW)).rejects.toThrow("no such table: b")
	})
})

/** A file to apply, its name standing for its hash */
const file = (filename: string, sql: string) => ({ filename, hash: filename, statements: [sql] })

/* S7 of the 0.15.0 review: a SQLite error that quotes a 429 was retried three times */
describe("applyRecorded on a SQLite failure that names a 429", () => {
	it("passes it on at once, read by its code", async () => {
		const conn = libsqlConnection()
		await ensureMigrationsTable(conn)
		await conn.client.executeMultiple("CREATE TABLE t429 (body TEXT); INSERT INTO t429 VALUES ('a'), ('a');")
		let calls = 0
		const counted: Connection = { ...conn, batch: (statements) => (calls++, conn.batch(statements)) }
		const unique = { filename: "2_u.sql", hash: "h2", statements: ["CREATE UNIQUE INDEX u ON t429 (body)"] }
		await expect(applyRecorded(counted, unique, { baseDelay: 0, maxDelay: 0 })).rejects.toThrow(
			"UNIQUE constraint failed: t429.body",
		)
		expect(calls).toBe(1)
	})
})

describe("applyEach", () => {
	it("stops at the first file that fails, naming the files that committed and the ones still pending", async () => {
		const conn = libsqlConnection()
		await ensureMigrationsTable(conn)
		const lines: string[] = []
		const files = [
			file("1_a.sql", "CREATE TABLE a (x)"),
			file("2_b.sql", "INSERT INTO b VALUES (1)"),
			file("3_c.sql", "SELECT 1"),
		]
		const failure = await applyEach(conn, files, { print: (line) => lines.push(line) }).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(Refused)
		const { applied, message, pending } = failure as Refused
		expect({ applied, message, pending }).toEqual({
			applied: ["1_a.sql"],
			message: expect.stringContaining("no such table: b"),
			pending: ["2_b.sql", "3_c.sql"],
		})
		expect(lines).toEqual(["Apply: 1_a.sql", "Apply: 2_b.sql", "Applied before the failure: 1_a.sql"])
		expect((await conn.execute("SELECT name FROM __drizzle_migrations")).rows).toEqual([["1_a.sql"]])
	})

	it("prints no applied files when the first fails, whatever it threw", async () => {
		const lines: string[] = []
		const conn = mockConnection({ batch: () => Promise.reject("lost") })
		const failure = await applyEach(conn, [file("1_a.sql", "SELECT 1")], { print: (line) => lines.push(line) }).catch(
			(error: unknown) => error,
		)
		expect([(failure as Refused).message, (failure as Refused).applied]).toEqual(["lost", []])
		expect(lines).toEqual(["Apply: 1_a.sql"])
	})
})

/** A lost connection as undici reports it: fetch failed, read ECONNRESET under it */
const reset = () =>
	new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) })

/** `conn` once `lost` names a batch: that batch commits, then every call fails as a lost connection */
function losing(conn: Connection, lost: string): Connection {
	let down = false
	return {
		...conn,
		batch: async (statements) => {
			if (down) throw reset()
			await conn.batch(statements)
			down = statements.some(({ params }) => params?.includes(lost) === true)
			if (down) throw reset()
		},
		execute: async (sql, params) => (down ? Promise.reject(reset()) : conn.execute(sql, params)),
	}
}

const LOST_FILES = [
	file("0001_t1.sql", "CREATE TABLE t1 (a)"),
	file("0002_t2.sql", "CREATE TABLE t2 (a)"),
	file("0003_t3.sql", "CREATE TABLE t3 (a)"),
]
const NO_WAIT = { baseDelay: 0, maxDelay: 0 }

/* S3 of r20: r19 S3's sibling on libsql, Turso and bun:sqlite, which plan 18 fixed on D1 only */
/** A bun:sqlite connection, on Node's SQLite under vitest (tests/bun/ runs bun's own) */
const bunConnection = () =>
	createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).connect({
		migrationsDir: "m",
		name: "local",
		provider: { path: ":memory:", type: "bun-sqlite" },
	})

describe("applyEach on a batch whose answer is lost", () => {
	it.each([
		["libsql", async (): Promise<Connection> => libsqlConnection()],
		["bun:sqlite", bunConnection],
	])("a committed batch with a lost answer is unknown, not pending, on %s", async (_, open) => {
		const conn = await open()
		await ensureMigrationsTable(conn)
		const failure = await applyEach(losing(conn, "0002_t2.sql"), LOST_FILES, { print: () => {}, retry: NO_WAIT }).catch(
			(error: unknown) => error,
		)
		expect(failure).toBeInstanceOf(Refused)
		const { applied, message, pending, unknown } = failure as Refused
		expect({ applied, pending, unknown }).toEqual({
			applied: ["0001_t1.sql"],
			pending: ["0003_t3.sql"],
			unknown: ["0002_t2.sql"],
		})
		expect(message).toBe(
			"0002_t2.sql may have committed: its batch failed with fetch failed: read ECONNRESET, and no read of comb's history answered after it; comb migrate status says whether it applied",
		)
		expect((await conn.execute("SELECT name FROM __drizzle_migrations")).rows).toEqual([
			["0001_t1.sql"],
			["0002_t2.sql"],
		])
	})

	it("a lost batch the history then reads as not run is pending, as any failure before it commits", async () => {
		const conn = libsqlConnection()
		await ensureMigrationsTable(conn)
		let calls = 0
		const refusing: Connection = {
			...conn,
			batch: async () => Promise.reject(++calls === 1 ? reset() : new Error("no such table: b")),
		}
		const failure = (await applyEach(refusing, LOST_FILES, { print: () => {}, retry: NO_WAIT }).catch(
			(error: unknown) => error,
		)) as Refused
		expect([failure.message, failure.pending, failure.unknown]).toEqual([
			"no such table: b",
			["0001_t1.sql", "0002_t2.sql", "0003_t3.sql"],
			[],
		])
	})
})
