/**
 * PA2 of r22b: Atlas runs a file without `-- atlas:txmode none` in one transaction and records it
 * there, so the file's own BEGIN, COMMIT or ROLLBACK ends that transaction: what ran before it stays
 * or is undone apart from the record, and a later failure is reported rolled back. comb refuses
 * them there, with no override, and leaves the savepoints, which nest, and a txmode none file's own.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(loadPostgresParser)

const UNSAFE = "-- comb:allow-unsafe: the file commits as it goes\n"

/** `sql` rated as a Postgres file after a history that makes t */
const rate = (sql: string) =>
	classifyMigration(sql, {
		before: extractSchema("CREATE TABLE t (x int);", undefined, "postgres"),
		dialect: "postgres",
	})

describe("a transactional file holds no transaction control (PA2; sibling: PA13's inside-only statements)", () => {
	it.each([
		["BEGIN … COMMIT", "BEGIN;\nINSERT INTO t VALUES (1);\nCOMMIT;\n", "BEGIN"],
		["a bare COMMIT", "INSERT INTO t VALUES (1);\nCOMMIT;\nINSERT INTO t VALUES (2);\n", "COMMIT"],
		["a ROLLBACK", "INSERT INTO t VALUES (1);\nROLLBACK;\n", "ROLLBACK"],
		["START TRANSACTION", "START TRANSACTION;\nINSERT INTO t VALUES (1);\n", "START TRANSACTION"],
		["END", "INSERT INTO t VALUES (1);\nEND;\n", "COMMIT"],
		["ABORT", "INSERT INTO t VALUES (1);\nABORT;\n", "ROLLBACK"],
		["COMMIT AND CHAIN", "INSERT INTO t VALUES (1);\nCOMMIT AND CHAIN;\n", "COMMIT"],
		["PREPARE TRANSACTION", "INSERT INTO t VALUES (1);\nPREPARE TRANSACTION 'p';\n", "PREPARE TRANSACTION"],
	])("refuses %s, whatever the file approves", (_, sql, control) => {
		expect(() => rate(`${UNSAFE}${sql}`)).toThrow(
			`Atlas runs this file in one transaction and records it there, so its own ${control} ends that transaction; to commit as you go, start the file with "-- atlas:txmode none" and a blank line`,
		)
	})

	it("leaves a txmode none file its own BEGIN, COMMIT and ROLLBACK", () => {
		const none = "-- atlas:txmode none\n\n"
		expect(() => rate(`${none}BEGIN;\nINSERT INTO t VALUES (1);\nCOMMIT;\n`)).not.toThrow()
		expect(() => rate(`${none}BEGIN;\nINSERT INTO t VALUES (1);\nROLLBACK;\n`)).not.toThrow()
	})

	it("leaves a transactional file its savepoints, which nest in Atlas's transaction", () => {
		expect(() =>
			rate("SAVEPOINT s;\nINSERT INTO t VALUES (1);\nROLLBACK TO SAVEPOINT s;\nRELEASE SAVEPOINT s;\n"),
		).not.toThrow()
	})
})

/* AE7 of r22: Atlas records a txmode none file after its last statement, in a block the file left open */
describe("a txmode none file ends the transaction it opens (AE7)", () => {
	const none = "-- atlas:txmode none\n\n"

	it.each([
		["BEGIN", `${none}BEGIN;\nINSERT INTO t VALUES (1);\n`, "BEGIN at line 3"],
		[
			"START TRANSACTION after comments",
			`${none}-- a\n/* b\n */ START TRANSACTION;\nINSERT INTO t VALUES (1);\n`,
			"START TRANSACTION at line 5",
		],
		["a second BEGIN", `${none}BEGIN;\nCOMMIT;\nINSERT INTO t VALUES (1); BEGIN;\n`, "BEGIN at line 5"],
		["COMMIT AND CHAIN", `${none}BEGIN;\nINSERT INTO t VALUES (1);\nCOMMIT AND CHAIN;\n`, "COMMIT AND CHAIN at line 5"],
		["ROLLBACK AND CHAIN", `${none}BEGIN;\nROLLBACK AND CHAIN;\n`, "ROLLBACK AND CHAIN at line 4"],
		[
			"BEGIN after comments in a chunk it shares",
			`-- atlas:delimiter GO\n${none}SELECT 1; -- c\n/* d */ BEGIN\nGO\n`,
			"BEGIN at line 5",
		],
	])("refuses a file that leaves its %s open", (_, sql, at) => {
		expect(() => rate(sql)).toThrow(
			`the file's ${at} is never committed: Atlas records a "-- atlas:txmode none" file after its last statement, in the transaction still open, and closing the connection rolls back both; end it with COMMIT or ROLLBACK`,
		)
	})

	it("names the BEGIN that opened a block a later BEGIN only warns in", () => {
		expect(() => rate(`${none}BEGIN;\nBEGIN;\nINSERT INTO t VALUES (1);\n`)).toThrow(
			"the file's BEGIN at line 3 is never committed",
		)
	})

	it("leaves a file whose block a COMMIT, a ROLLBACK or a PREPARE TRANSACTION ends", () => {
		expect(() => rate(`${none}BEGIN;\nINSERT INTO t VALUES (1);\nCOMMIT;\n`)).not.toThrow()
		expect(() => rate(`${none}START TRANSACTION;\nCOMMIT AND CHAIN;\nROLLBACK;\n`)).not.toThrow()
		expect(() => rate(`${none}BEGIN;\nINSERT INTO t VALUES (1);\nPREPARE TRANSACTION 'p';\n`)).not.toThrow()
	})
})
