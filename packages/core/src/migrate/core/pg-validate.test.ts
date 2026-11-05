/**
 * PA8 of r22b: comb's NOT VALID recipe has a constraint added NOT VALID, then validated. Atlas runs a
 * file in one transaction, so a VALIDATE in the file that added the constraint scans every row while
 * the ADD's lock is held to COMMIT: ACCESS EXCLUSIVE for a CHECK, which blocks reads, SHARE ROW
 * EXCLUSIVE on both tables for a foreign key, which blocks writes. Probed on Postgres 17
 * (.tmp/grunt/r22b/lock/notvalid-same-file.ts, lock/attach-recipe.ts). A VALIDATE in a later file
 * holds only SHARE UPDATE EXCLUSIVE, and a txmode none file commits each statement outside its own
 * BEGIN as it goes.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(loadPostgresParser)

const HISTORY = [
	"CREATE TABLE users (id int PRIMARY KEY, n int);",
	"CREATE TABLE orders (id int, user_id int);",
	"CREATE TABLE ev (id int, at date) PARTITION BY RANGE (at);",
	"CREATE TABLE ev_old (id int, at date);",
].join("\n")

/** `sql` rated as a Postgres file after HISTORY */
const rate = (sql: string) =>
	classifyMigration(sql, { before: extractSchema(HISTORY, undefined, "postgres"), dialect: "postgres" })

const HELD = "the ADD's lock is held through this scan; validate in a later file"

const CHECK_ADD = "ALTER TABLE users ADD CONSTRAINT pos CHECK (n > 0) NOT VALID;"
const CHECK_VALIDATE = "ALTER TABLE users VALIDATE CONSTRAINT pos;"
const FK_ADD = "ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;"
const FK_VALIDATE = "ALTER TABLE orders VALIDATE CONSTRAINT fk;"
const BOUND_ADD = "ALTER TABLE ev_old ADD CONSTRAINT b CHECK (at >= '2020-01-01' AND at < '2021-01-01') NOT VALID;"
const BOUND_VALIDATE = "ALTER TABLE ev_old VALIDATE CONSTRAINT b;"
const ATTACH = "ALTER TABLE ev ATTACH PARTITION ev_old FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');"

describe("a VALIDATE in the transaction that added its constraint NOT VALID (PA8; sibling: the plain ADD's scan)", () => {
	it("warns of a CHECK's, which scans while the ADD's lock blocks reads and writes", () => {
		expect(rate(`${CHECK_ADD}\n${CHECK_VALIDATE}\n`).lockWarnings).toEqual([
			`${CHECK_VALIDATE.slice(0, -1)} (scans users while this file holds it locked against reads and writes; ${HELD})`,
		])
	})

	it("warns of a foreign key's, which scans while the ADD's lock blocks writes to both tables", () => {
		expect(rate(`${FK_ADD}\n${FK_VALIDATE}\n`).lockWarnings).toEqual([
			`${FK_VALIDATE.slice(0, -1)} (scans orders while this file holds orders and users locked against writes; ${HELD})`,
		])
	})

	it("warns of the ATTACH recipe's, written in one file", () => {
		expect(rate(`${BOUND_ADD}\n${BOUND_VALIDATE}\n${ATTACH}\n`).lockWarnings).toEqual([
			`${BOUND_VALIDATE.slice(0, -1)} (scans ev_old while this file holds it locked against reads and writes; ${HELD})`,
			expect.stringMatching(/^ALTER TABLE ev ATTACH PARTITION ev_old .* \(scans ev_old under an exclusive lock/),
		])
	})

	it("warns of one in the ADD's own statement", () => {
		const sql = "ALTER TABLE users ADD CONSTRAINT pos CHECK (n > 0) NOT VALID, VALIDATE CONSTRAINT pos;"
		expect(rate(sql).lockWarnings).toEqual([
			`${sql.slice(0, 80)}... (scans users while this file holds it locked against reads and writes; ${HELD})`,
		])
	})

	it("warns of none for the recipe across two files", () => {
		expect(rate(`${CHECK_ADD}\n`).lockWarnings).toEqual([])
		expect(rate(`${CHECK_VALIDATE}\n`).lockWarnings).toEqual([])
		expect(rate(`${FK_ADD}\n`).lockWarnings).toEqual([])
		expect(rate(`${FK_VALIDATE}\n`).lockWarnings).toEqual([])
	})

	it("warns of none in a txmode none file, which commits each statement, and of one inside its own BEGIN", () => {
		const none = "-- atlas:txmode none\n\n"
		expect(rate(`${none}${CHECK_ADD}\n${CHECK_VALIDATE}\n`).lockWarnings).toEqual([])
		expect(rate(`${none}BEGIN;\n${CHECK_ADD}\nCOMMIT;\n${CHECK_VALIDATE}\n`).lockWarnings).toEqual([])
		expect(rate(`${none}BEGIN;\n${CHECK_ADD}\n${CHECK_VALIDATE}\nCOMMIT;\n`).lockWarnings).toEqual([
			`${CHECK_VALIDATE.slice(0, -1)} (scans users while this file holds it locked against reads and writes; ${HELD})`,
		])
	})
})

describe("what a VALIDATE under a held lock names (PA8)", () => {
	it("names every table the file holds, a later VALIDATE of another table's included", () => {
		expect(rate(`${CHECK_ADD}\n${FK_ADD}\n${FK_VALIDATE}\n`).lockWarnings).toEqual([
			`${FK_VALIDATE.slice(0, -1)} (scans orders while this file holds users locked against reads and writes, and orders against writes; ${HELD})`,
		])
	})

	it("warns of a self-referencing foreign key's, its table held against writes", () => {
		const add = "ALTER TABLE users ADD CONSTRAINT boss FOREIGN KEY (n) REFERENCES users (id) NOT VALID;"
		expect(rate(`${add}\nALTER TABLE users VALIDATE CONSTRAINT boss;\n`).lockWarnings).toEqual([
			`ALTER TABLE users VALIDATE CONSTRAINT boss (scans users while this file holds it locked against writes; ${HELD})`,
		])
	})

	it("names the tables held against reads and writes alone", () => {
		expect(rate(`${BOUND_ADD}\n${CHECK_ADD}\n${CHECK_VALIDATE}\n`).lockWarnings).toEqual([
			`${CHECK_VALIDATE.slice(0, -1)} (scans users while this file holds ev_old and users locked against reads and writes; ${HELD})`,
		])
	})
})

describe("every NOT VALID recipe says to validate in a later file (PA8)", () => {
	it.each([
		[
			"ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id);",
			"then VALIDATE CONSTRAINT in a later file",
		],
		[
			"ALTER TABLE orders ADD COLUMN w int DEFAULT 1 REFERENCES users (id);",
			"then VALIDATE CONSTRAINT in a later file",
		],
		[ATTACH, "VALIDATE it in a later file, then ATTACH"],
		["ALTER TABLE ev ATTACH PARTITION ev_old DEFAULT;", "VALIDATE it in a later file, then ATTACH"],
	])("%s", (sql, recipe) => {
		expect(rate(sql).lockWarnings.join(" ")).toContain(recipe)
	})
})
