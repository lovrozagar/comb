import { afterEach, describe, expect, it } from "vitest"
import { libsqlConnection, type LibsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { type Proof, provePending } from "./proof-run.ts"

const open: LibsqlConnection[] = []
afterEach(async () => {
	for (const conn of open.splice(0)) await conn.close()
})

/** The proof of `file` on a database `live` made: the engine and the compare only, no text rule */
async function prove(live: string, file: string): Promise<Proof> {
	const conn = libsqlConnection()
	open.push(conn)
	await conn.client.executeMultiple(live)
	const proofs = await provePending(conn, [{ name: "2_file.sql", sql: file }])
	return proofs.get("2_file.sql") as Proof
}

const EXTERNAL =
	"CREATE TABLE post (id INTEGER PRIMARY KEY, body TEXT);\nCREATE VIRTUAL TABLE ext USING fts5(body, content='post', content_rowid='id');"
const CONTENTLESS = "CREATE VIRTUAL TABLE cl USING fts5(body, content='');"

/* M42 part 2: a mirror's rows are its content table's, so the proof compares its index instead */
describe("the proof on a mirror FTS table's index", () => {
	it("finds an external-content index emptied, however the command is spelled", async () => {
		const proof = await prove(EXTERNAL, "INSERT OR IGNORE INTO ext(ext) VALUES ('delete-all');")
		expect(proof.unsafe.some((finding) => /full-text index of ext/.test(finding))).toBe(true)
	})

	it("finds a contentless index emptied", async () => {
		const proof = await prove(CONTENTLESS, "INSERT INTO cl(cl) VALUES ('delete-all');")
		expect(proof.unsafe.some((finding) => /full-text index of cl/.test(finding))).toBe(true)
	})

	it("lists unproven a mirror whose index the copy cannot build, with why", async () => {
		const live =
			"CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT);\nCREATE VIRTUAL TABLE ext USING fts5(body, content='post', content_rowid='id');"
		const proof = await prove(live, "SELECT 1;")
		expect(proof.unproven).toEqual([
			{ table: "ext", why: expect.stringMatching(/^comb could not build its full-text index in the copy: /) as string },
		])
	})

	it("counts nothing for a mirror that keeps no docsize or idx, and nothing for one the file drops", async () => {
		const fts3 = "CREATE VIRTUAL TABLE old USING fts4(body, content='', matchinfo='fts3');"
		expect((await prove(fts3, "INSERT INTO old(old) VALUES ('optimize');")).unsafe).toEqual([])
		const dropped = await prove(EXTERNAL, "DROP TABLE ext;")
		expect(dropped.unsafe.filter((finding) => /full-text index/.test(finding))).toEqual([])
	})

	it("finds nothing in an index a file rebuilds whole", async () => {
		const proof = await prove(EXTERNAL, "INSERT INTO ext(ext) VALUES ('rebuild');")
		expect(proof.unsafe).toEqual([])
	})
})
