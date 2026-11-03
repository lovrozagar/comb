/**
 * SL2 of r22: comb applies each piece of its split as one statement, and a driver that runs the
 * first statement of a string alone drops the rest. So the proof asks SQLite where each piece's
 * first statement ends, and refuses a piece SQLite reads as more than one, naming the file and the
 * statement. The splitter here is made to fold a file into one piece, as 0.20.1's did after a
 * trigger naming `begin`; with SQLite's own split no file reaches this.
 */
import { describe, expect, it, vi } from "vitest"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { provePending } from "./proof-run.ts"

vi.mock("./sql-scan.ts", async (original) => {
	const scan = await original<typeof import("./sql-scan.ts")>()
	/* every file one piece, its last ; dropped, as a split that missed where SQLite ends a statement */
	return { ...scan, splitSqlStatements: (sql: string) => [sql.trim().replace(/;$/, "")] }
})

describe("a SQLite file splits where SQLite ends a statement (SL2; sibling: libsql's skipped tail)", () => {
	it("refuses a piece SQLite reads as two statements at check, naming the file and the statement", async () => {
		const live = libsqlConnection()
		try {
			await live.client.executeMultiple(
				"CREATE TABLE ev (id INTEGER PRIMARY KEY, begin INTEGER);\nCREATE TABLE audit (at INTEGER);",
			)
			const file =
				"CREATE TRIGGER ev_audit AFTER INSERT ON ev BEGIN INSERT INTO audit (at) VALUES (new.begin); END;\nALTER TABLE ev ADD COLUMN label TEXT;"
			await expect(provePending(live, [{ name: "2_audit.sql", sql: file }])).rejects.toThrow(
				/^2_audit\.sql: CREATE TRIGGER ev_audit .*: SQLite reads this as more than one statement/,
			)
		} finally {
			await live.close()
		}
	})

	it("passes a piece that is one statement, a comment after it included", async () => {
		const live = libsqlConnection()
		try {
			await live.client.executeMultiple("CREATE TABLE ev (id INTEGER PRIMARY KEY);")
			const proofs = await provePending(live, [{ name: "1_ix.sql", sql: "CREATE INDEX ev_id ON ev (id) -- a note;" }])
			expect(proofs.get("1_ix.sql")?.failed).toBeUndefined()
		} finally {
			await live.close()
		}
	})
})
