import { createClient } from "@libsql/client"
import { describe, expect, it } from "vitest"
import { quoteIdent } from "./identifier.ts"

describe("quoteIdent", () => {
	it("wraps a name in double quotes and doubles the quotes inside it", () => {
		expect(quoteIdent("post")).toBe('"post"')
		expect(quoteIdent('we"ird')).toBe('"we""ird"')
	})

	it("names a column SQLite reads back as one identifier, whatever it holds", async () => {
		const client = createClient({ url: ":memory:" })
		try {
			const hostile = 'x" FROM sqlite_master; --'
			await client.execute(`CREATE TABLE t (${quoteIdent(hostile)} TEXT)`)
			await client.execute(`INSERT INTO t VALUES ('kept')`)
			const { rows } = await client.execute(`SELECT ${quoteIdent(hostile)} AS v FROM t`)
			expect(rows.map((row) => row["v"])).toEqual(["kept"])
		} finally {
			client.close()
		}
	})
})
