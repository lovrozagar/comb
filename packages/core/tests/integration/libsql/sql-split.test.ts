/**
 * SL2 of r22: comb's split of a SQLite file, applied through each driver, leaves what SQLite leaves
 * when it runs the file whole. bun:sqlite's statement (Node's here) and libsql's client run the
 * first statement of a string alone, so a statement folded into a trigger's is lost there, and a
 * trigger cut in two fails everywhere; libsql's file apply runs a string whole.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, describe, expect, it, vi } from "vitest"
import { CORPUS, CORPUS_SETUP, corpusFile } from "../../../src/migrate/__fixtures__/trigger-corpus.ts"
import { splitSqlStatements } from "../../../src/migrate/core/sql-scan.ts"
import { openLibsqlFile } from "../../../src/migrate/drivers/libsql-file.ts"
import { createBunSqliteProvider, createLibsqlProvider } from "../../../src/migrate/drivers/sqlite.ts"

vi.mock("bun:sqlite", () => import("../../../src/migrate/__fixtures__/bun-sqlite-node.ts"))

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "comb-sql-split-"))
afterAll(() => fs.rmSync(DIR, { force: true, recursive: true }))

/** How each driver applies a file's statements to the database at `file`, in one transaction */
const DRIVERS: Record<string, (file: string, statements: string[]) => Promise<void>> = {
	"bun:sqlite": async (file, statements) => {
		const provider = { path: file, type: "bun-sqlite" } as const
		const conn = await createBunSqliteProvider(provider).connect({ migrationsDir: "m", name: "local", provider })
		try {
			await conn.batch(statements.map((sql) => ({ sql })))
		} finally {
			await conn.close()
		}
	},
	"libsql client": async (file, statements) => {
		const provider = { type: "libsql", url: `file:${file}` } as const
		const conn = await createLibsqlProvider(provider).connect({ migrationsDir: "m", name: "local", provider })
		try {
			await conn.batch(statements.map((sql) => ({ sql })))
		} finally {
			await conn.close()
		}
	},
	"libsql file": async (file, statements) => {
		const conn = await openLibsqlFile(file)
		try {
			await conn.batch(statements.map((sql) => ({ sql })))
		} finally {
			await conn.close()
		}
	},
}

let made = 0

/** A new database file holding the corpus's tables */
function fresh(): string {
	const file = path.join(DIR, `${++made}.db`)
	const db = new DatabaseSync(file)
	db.exec(CORPUS_SETUP)
	db.close()
	return file
}

/** What the database at `file` holds: its schema and every table's rows */
function state(file: string): unknown {
	const db = new DatabaseSync(file)
	try {
		const master = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()
		const rows = Object.fromEntries(
			["ev", "log", "begin"].map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]),
		)
		return { master, rows }
	} finally {
		db.close()
	}
}

describe("a SQLite file splits where SQLite ends a statement (SL2; sibling: libsql's skipped tail)", () => {
	describe.each(Object.keys(DRIVERS))("applied through %s", (driver) => {
		it.each(CORPUS.map(({ label, statements }) => [label, corpusFile(statements)]))(
			"leaves what SQLite's own exec leaves for %s",
			async (_, sql) => {
				const whole = fresh()
				const own = new DatabaseSync(whole)
				own.exec(sql)
				own.close()
				const split = fresh()
				await (DRIVERS[driver] as (typeof DRIVERS)[string])(split, splitSqlStatements(sql))
				expect(state(split)).toEqual(state(whole))
			},
		)
	})
})
