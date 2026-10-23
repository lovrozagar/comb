/**
 * The proof after a file the copy refuses (M7): ordinary files fail on a seeded copy (a new unique
 * index, an explicit id, a real parent), and one such file turned the proof off for every file
 * after it. The seed no longer repeats values or uses ids a migration writes; a file that still
 * fails is reseeded once on a fresh copy, and only then proves nothing, with every later file.
 */
import { afterEach, describe, expect, it } from "vitest"
import { libsqlConnection, type LibsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { type Proof, provePending } from "./proof-run.ts"

const open: LibsqlConnection[] = []
afterEach(async () => {
	for (const conn of open.splice(0)) await conn.close()
})

/** Each file's proof, by name, on a database `live` made */
async function prove(live: string, files: Array<[string, string]>): Promise<Map<string, Proof>> {
	const conn = libsqlConnection()
	open.push(conn)
	await conn.client.executeMultiple(live)
	return provePending(
		conn,
		files.map(([name, sql]) => ({ name, sql })),
	)
}

const LIVE =
	"CREATE TABLE plans (id INTEGER PRIMARY KEY, name TEXT);\nCREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, plan_id INTEGER REFERENCES plans (id));"
const LOSSY = ["2_lossy.sql", "DELETE FROM users;"] as [string, string]

describe("provePending after a file the copy refuses (M7)", () => {
	it.each([
		["a new unique index", "CREATE UNIQUE INDEX users_email ON users (email);"],
		["an insert with an explicit id", "INSERT INTO plans (id, name) VALUES (7, 'team');"],
	])("proves %s, and the lossy file after it", async (_, first) => {
		const proofs = await prove(LIVE, [["1_first.sql", first], LOSSY])
		expect(proofs.get("1_first.sql")?.failed).toBeUndefined()
		expect(proofs.get("2_lossy.sql")?.unsafe.join("\n")).toMatch(/loses 6 of the 6 rows of users/)
	})

	it("leaves a file the copy refuses twice, and every file after it, unproven", async () => {
		/* plan 1 is a real parent the copy cannot hold: the target has it, the copy never will */
		const proofs = await prove(LIVE, [
			["1_parent.sql", "INSERT INTO users (email, plan_id) VALUES ('c@x.io', 1);"],
			LOSSY,
		])
		expect(proofs.get("1_parent.sql")?.failed).toMatch(
			/^comb could not run this in the proof copy: .*FOREIGN KEY constraint failed/,
		)
		expect(proofs.get("2_lossy.sql")?.failed).toMatch(/an earlier pending file, 1_parent\.sql, could not run/)
	})

	/* ids that meet a seed's keys on purpose: 2^40 + 7 is the first seed's, 2^41 + 50 007 the reseed's */
	it("replays the files that applied on the reseeded copy, and proves the file that failed", async () => {
		const proofs = await prove(LIVE, [
			["1_ok.sql", "INSERT INTO plans (id, name) VALUES (5, 'five');"],
			["2_collides.sql", `INSERT INTO plans (id, name) VALUES (${2 ** 40 + 7}, 'seeded');`],
			LOSSY,
		])
		expect(proofs.get("2_collides.sql")?.failed).toBeUndefined()
		expect(proofs.get("2_lossy.sql")?.unsafe.join("\n")).toMatch(/loses 6 of the 6 rows of users/)
	})

	it("proves nothing more when a file that applied before no longer applies on the reseeded copy", async () => {
		const proofs = await prove(LIVE, [
			["1_meets_reseed.sql", `INSERT INTO plans (id, name) VALUES (${2 ** 41 + 50_007}, 'x');`],
			["2_parent.sql", "INSERT INTO users (email, plan_id) VALUES ('c@x.io', 1);"],
		])
		expect(proofs.get("1_meets_reseed.sql")?.failed).toBeUndefined()
		expect(proofs.get("2_parent.sql")?.failed).toMatch(
			/could not run this in the proof copy: .*FOREIGN KEY constraint failed/,
		)
	})
})
