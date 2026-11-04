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
