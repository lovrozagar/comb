/**
 * QE1 of r22: sqld sends each error with the bare primary code (Hrana carries no extended code) and
 * its message prefixed `SQLite error: `. An app on remote libsql or Turso must get from
 * classifySqliteError what it gets on a libsql file: the status, the key, the map entry and the
 * column. Hrana sends no extended code, so what only that code tells apart reads otherwise (HRANA).
 */
import { type Client, createClient } from "@libsql/client"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { classifySqliteError } from "../../../src/sqlite/constraint-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"
import { type Sqld, startSqld } from "../../support/sqld.ts"

const SCHEMA = [
	"CREATE TABLE parent (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, n INTEGER CONSTRAINT n_nonneg CHECK (n >= 0), secret TEXT UNIQUE, a TEXT, b TEXT, m INTEGER CHECK (m < 100))",
	"CREATE UNIQUE INDEX parent_ab ON parent (a, b)",
	"CREATE UNIQUE INDEX parent_email_lower ON parent (lower(email))",
	"CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id))",
	"CREATE TABLE s (id INTEGER PRIMARY KEY, n INTEGER, t TEXT) STRICT",
	"CREATE TABLE q (id TEXT PRIMARY KEY, qty INTEGER)",
	"CREATE TRIGGER q_qty BEFORE INSERT ON q WHEN NEW.qty < 0 BEGIN SELECT RAISE(ABORT, 'qty must be positive'); END",
	"CREATE VIRTUAL TABLE docs_fts USING fts5(body)",
	"CREATE TABLE rk (k INTEGER PRIMARY KEY, v TEXT)",
	"INSERT INTO parent (id, email, name, n, secret, a, b) VALUES ('p1', 'a@x.io', 'A', 1, 's1', 'x', 'y')",
	"INSERT INTO child (id, parent_id) VALUES ('c1', 'p1')",
	"INSERT INTO docs_fts (rowid, body) VALUES (1, 'hello')",
	"INSERT INTO rk (k, v) VALUES (1, 'a')",
]

const MAP: ConstraintMap = {
	child: { foreignKey: { parent_id: { cause: "no such parent", errorKey: "parent_missing" } } },
	parent: {
		check: { n_nonneg: { cause: "n must not be negative", errorKey: "n_negative", statusKey: "bad_request" } },
		private: ["secret"],
		unique: {
			email: { cause: "email taken", errorKey: "email_taken" },
			parent_email_lower: { cause: "email taken (case)", errorKey: "email_taken_ci" },
		},
	},
}

/* the cases of r22's sqlite-matrix that fail the same way on every libsql database */
const CASES: Array<[string, string]> = [
	["unique email", "INSERT INTO parent (id, email, name) VALUES ('p2', 'a@x.io', 'B')"],
	["unique private secret", "INSERT INTO parent (id, email, name, secret) VALUES ('p2', 'b@x.io', 'B', 's1')"],
	["unique composite a,b", "INSERT INTO parent (id, email, name, a, b) VALUES ('p2', 'b@x.io', 'B', 'x', 'y')"],
	["unique expression lower(email)", "INSERT INTO parent (id, email, name) VALUES ('p2', 'A@X.IO', 'B')"],
	["primary key", "INSERT INTO parent (id, email, name) VALUES ('p1', 'c@x.io', 'B')"],
	["rowid key", "INSERT INTO rk (k, v) VALUES (1, 'b')"],
	["fts5 rowid", "INSERT INTO docs_fts (rowid, body) VALUES (1, 'again')"],
	["not null", "INSERT INTO parent (id, email) VALUES ('p3', 'd@x.io')"],
	["check named", "INSERT INTO parent (id, email, name, n) VALUES ('p3', 'd@x.io', 'D', -1)"],
	["check unnamed", "INSERT INTO parent (id, email, name, m) VALUES ('p3', 'd@x.io', 'D', 500)"],
	["fk insert child", "INSERT INTO child (id, parent_id) VALUES ('c2', 'nope')"],
	["fk delete parent", "DELETE FROM parent WHERE id = 'p1'"],
	["fk update child key", "UPDATE child SET parent_id = 'nope' WHERE id = 'c1'"],
	["strict text into int", "INSERT INTO s (n) VALUES ('abc')"],
	["strict blob into text", "INSERT INTO s (t) VALUES (x'00ff')"],
	[
		"upsert fk",
		"INSERT INTO child (id, parent_id) VALUES ('c1', 'p1') ON CONFLICT (id) DO UPDATE SET parent_id = 'nope'",
	],
	["insert or fail unique", "INSERT OR FAIL INTO parent (id, email, name) VALUES ('p9', 'a@x.io', 'Z')"],
	["trigger raise", "INSERT INTO q (id, qty) VALUES ('q1', -5)"],
]

/*
 * What only an extended code tells apart. A trigger's RAISE has no _TRIGGER, so its message cannot be
 * told from SQLite's own words and the generic cause stands for it. A key conflict has no _PRIMARYKEY,
 * and SQLite words it as a unique one (`UNIQUE constraint failed: parent.id`): the same 409, read as
 * the unique violation it is worded as.
 */
const HRANA: Record<string, Record<string, unknown>> = {
	"primary key": {
		cause: "Duplicate value for parent.id",
		column: "id",
		errorKey: "unique_constraint_violation",
		status: 409,
	},
	"rowid key": { cause: "Duplicate value detected", errorKey: "unique_constraint_violation", status: 409 },
	"trigger raise": { cause: "Constraint violated" },
}

/** What an app sees of a failed statement: classifySqliteError's answer, as fields */
async function answer(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
	const error = await run().then(
		() => undefined,
		(thrown: unknown) => thrown,
	)
	expect(error, "the statement failed").toBeDefined()
	const read = classifySqliteError(error, [MAP]) as unknown as Record<string, unknown>
	return { cause: read["cause"], column: read["column"], errorKey: read["errorKey"], status: read["status"] }
}

let server: Sqld
let dir: string
let file: Client
const remote: Record<string, Client> = {}

beforeAll(async () => {
	server = await startSqld()
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-sqld-errors-"))
	file = createClient({ url: `file:${path.join(dir, "file.db")}` })
	await file.execute("PRAGMA foreign_keys = ON")
	for (const sql of SCHEMA) await file.execute(sql)
	const setup = createClient({ url: server.http })
	for (const sql of SCHEMA) await setup.execute(sql)
	setup.close()
	remote["http"] = createClient({ url: server.http })
	remote["ws"] = createClient({ url: server.ws })
}, 60_000)

afterAll(async () => {
	for (const client of Object.values(remote)) client.close()
	file.close()
	await server.stop()
	fs.rmSync(dir, { force: true, recursive: true })
})

describe("a sqld constraint violation classifies as on a file (QE1; sibling: the `extendedCode` branch)", () => {
	describe.each(["http", "ws"])("over %s", (scheme) => {
		it.each(CASES)("answers %s as a libsql file does", async (name, sql) => {
			const client = remote[scheme] as Client
			const local = await answer(() => file.execute(sql))
			for (const [how, run] of [
				["execute", () => client.execute(sql)],
				["batch", () => client.batch([sql], "write")],
			] as const) {
				const expected = { ...local, ...HRANA[name] }
				expect(await answer(run), how).toEqual(expected)
			}
		})
	})
})
