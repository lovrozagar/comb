import { describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { extractSchema } from "./schema.ts"

/** The functions and procedures `sql`'s history leaves, each key with its kind and signatures */
const routines = (sql: string) =>
	Object.fromEntries(
		[...historyFacts(extractSchema(sql, undefined, "postgres"), "public").routines].map(
			([key, { kind, signatures }]) => [key, { kind, signatures: [...signatures.keys()].sort() }],
		),
	)

const FN = (name: string, args = "") => `CREATE FUNCTION ${name}(${args}) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`

/* 5.4b: what a baseline compares by name against the database, a dropped overload leaving its siblings */
describe("the functions and procedures a Postgres history leaves", () => {
	it("keys each by name under the schema, its signature its input arguments' types", () => {
		expect(
			routines(
				`${FN("f", "a integer, OUT b int, VARIADIC c text[]")}\nCREATE PROCEDURE app.p(int4) LANGUAGE sql AS $$ SELECT 1 $$;\n${FN("public.g")}`,
			),
		).toEqual({
			"app.p": { kind: "procedure", signatures: ["int4"] },
			f: { kind: "function", signatures: ["int4,text[]"] },
			g: { kind: "function", signatures: [""] },
		})
	})

	it("keeps one signature through CREATE OR REPLACE, and a sibling through its overload's drop", () => {
		const replaced = `${FN("f", "int")}\n${FN("f", "int").replace("CREATE", "CREATE OR REPLACE")}`
		expect(routines(replaced)).toEqual({ f: { kind: "function", signatures: ["int4"] } })
		expect(routines(`${FN("f", "int")}\n${FN("f", "text")}\nDROP FUNCTION f(integer);`)).toEqual({
			f: { kind: "function", signatures: ["text"] },
		})
		expect(routines(`${FN("f", "int")}\n${FN("f", "text")}\nDROP FUNCTION f(int), f(text);`)).toEqual({})
	})

	it("drops every signature of a name dropped without its arguments, and names no one it never made", () => {
		expect(routines(`${FN("f")}\n${FN("g")}\nDROP FUNCTION f, missing;\nDROP ROUTINE g();`)).toEqual({})
		expect(routines(`${FN("f", "int")}\nDROP FUNCTION f(text);`)).toEqual({
			f: { kind: "function", signatures: ["int4"] },
		})
	})

	it("follows a rename, a move to another schema and a schema renamed, a procedure keeping its kind", () => {
		const sql = [
			FN("f", "int"),
			FN("f", "text"),
			"ALTER FUNCTION f(int) RENAME TO h;",
			"CREATE PROCEDURE p(int) LANGUAGE sql AS $$ SELECT 1 $$;",
			"ALTER PROCEDURE p(int) SET SCHEMA app;",
			"ALTER SCHEMA app RENAME TO app2;",
			"ALTER FUNCTION gone() RENAME TO still_gone;",
		].join("\n")
		expect(routines(sql)).toEqual({
			"app2.p": { kind: "procedure", signatures: ["int4"] },
			f: { kind: "function", signatures: ["text"] },
			h: { kind: "function", signatures: ["int4"] },
		})
	})

	it("is no aggregate, whose CREATE AGGREGATE defines no function or procedure", () => {
		expect(routines("CREATE AGGREGATE agg (int) (sfunc = int4pl, stype = int);")).toEqual({})
	})
})
