import { describe, expect, it } from "vitest"
import { keyOf, names, nodesOf, tableOf, typeOf } from "./pg-nodes.ts"
import { postgresParser } from "./pg-parser.ts"

const tree = (sql: string) => postgresParser().parseSync(sql).stmts

describe("a Postgres parse tree's nodes and names", () => {
	it("lists every node by type, and keys a name as nameKey does: pg_catalog and public left out", () => {
		const types = nodesOf(tree("INSERT INTO public.t SELECT lower(x) FROM u")).map(([type]) => type)
		expect(types).toEqual(expect.arrayContaining(["InsertStmt", "RangeVar", "FuncCall", "ColumnRef"]))
		expect(keyOf(["pg_catalog", "lower"])).toBe("lower")
		expect(keyOf(["app", "lower"])).toBe("app.lower")
		expect(keyOf(["public"])).toBe("public")
		expect(names([{ String: { sval: "a" } }, { String: { sval: "b" } }])).toEqual(["a", "b"])
	})

	it("reads a table's key and whether it is temporary, and a type's key", () => {
		expect(tableOf({ relname: "t", relpersistence: "t" })).toEqual({ key: "t", name: "t", temp: true })
		expect(tableOf({ relname: "t", relpersistence: "p", schemaname: "pg_temp" }).temp).toBe(true)
		expect(tableOf({ relname: "t", relpersistence: "p", schemaname: "app" })).toEqual({
			key: "app.t",
			name: "t",
			temp: false,
		})
		expect(typeOf({ names: [{ String: { sval: "pg_catalog" } }, { String: { sval: "int4" } }] })).toBe("int4")
	})
})
