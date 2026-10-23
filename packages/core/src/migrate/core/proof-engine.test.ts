import { describe, expect, it } from "vitest"
import { FILE, type Read, START, stateOf } from "../__fixtures__/apply-parity.ts"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { openMemory } from "../drivers/memory.ts"
import { splitSqlStatements } from "./sql-scan.ts"
import { applyToCopy } from "./proof-engine.ts"
import { provePending } from "./proof-run.ts"

/** A libsql connection's reads, each row as its columns by name */
const readOf =
	(conn: ReturnType<typeof libsqlConnection>): Read =>
	async (sql) => {
		const { columns, rows } = await conn.execute(sql)
		return rows.map((row) => Object.fromEntries(columns.map((column, i) => [column, row[i]])))
	}

describe("the proof's engine pass leaves the copy as the target's own apply leaves the target", () => {
	it("ends in the same schema and rows on node:sqlite as a libsql target does", async () => {
		const target = libsqlConnection()
		await target.client.executeMultiple(START)
		await target.batch(splitSqlStatements(FILE).map((sql) => ({ sql })))
		const copy = await openMemory()
		copy.exec(START)
		expect(applyToCopy(copy, FILE).error).toBeUndefined()
		expect(await stateOf(async (sql) => copy.all(sql))).toEqual(await stateOf(readOf(target)))
		copy.close()
		await target.close()
	})

	it("leaves the target's schema and rows as they were: the proof only reads it", async () => {
		const target = libsqlConnection()
		await target.client.executeMultiple(START)
		const before = await stateOf(readOf(target))
		const proofs = await provePending(target, [{ name: "1_m.sql", sql: FILE }])
		expect(proofs.get("1_m.sql")?.failed).toBeUndefined()
		expect(await stateOf(readOf(target))).toEqual(before)
		await target.close()
	})
})
