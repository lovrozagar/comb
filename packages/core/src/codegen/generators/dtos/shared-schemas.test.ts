import { describe, expect, it } from "vitest"
import type { ImportsMeta } from "../../analyzer-types.ts"
import type { FieldInfo, TableInfo } from "./dto-types.ts"
import { buildSharedSchemas, rewriteBaseTypes, rewriteWithShared } from "./shared-schemas.ts"

function table(name: string, zodTypes: string[]): TableInfo {
	const fields: FieldInfo[] = zodTypes.map((zodType, i) => ({ key: `f${i}`, type: "read", zodType }))
	return {
		combMeta: null,
		fields,
		hasTimestamps: { createdAt: false, deletedAt: false, updatedAt: false },
		name,
		needsSharedMeta: false,
		timestampStyle: "camelCase",
	}
}

const imports = (external: string[] = []): ImportsMeta => ({
	enumImports: new Map(external.map((name) => [name, "./enums"])),
	identifiers: new Map(),
	jsonSchemaImports: new Set(),
})

const shared = (tables: TableInfo[], external: string[] = []) =>
	Object.fromEntries(
		[...buildSharedSchemas(tables, imports(external))].map(([zodType, s]) => [
			zodType,
			`${s.name} = ${s.code} (${s.count})`,
		]),
	)

describe("buildSharedSchemas", () => {
	it("shares a base used three times, or twice across tables, with the variants in use", () => {
		const s = "z.string().max(10)"
		expect(
			shared([table("a", [s, `${s}.nullable()`, `${s}.nullable().optional()`]), table("b", [`${s}.optional()`])]),
		).toEqual({
			[s]: "_z0 = _str.max(10) (1)",
			[`${s}.nullable()`]: "_z1 = _z0.nullable() (1)",
			[`${s}.nullable().optional()`]: "_z2 = _z1.optional() (1)",
			[`${s}.optional()`]: "_z3 = _z0.optional() (1)",
		})
		expect(shared([table("a", ["z.number()"]), table("b", ["z.number()"])])).toEqual({ "z.number()": "_z0 = _num (2)" })
		expect(shared([table("a", ["z.number()", "z.number()"])])).toEqual({})
	})

	it("emits a nullable variant needed only by its optional form", () => {
		const s = "z.string().max(3)"
		expect(Object.keys(shared([table("a", [s, s, `${s}.nullable().optional()`])]))).toEqual([
			s,
			`${s}.nullable()`,
			`${s}.nullable().optional()`,
		])
	})

	it("shares a structural core two tables use with different examples", () => {
		const result = shared([
			table("a", ['z.string().max(5).meta({ examples: ["a"] })']),
			table("b", ['z.string().max(5).meta({ examples: ["b"] })']),
		])
		expect(result).toEqual({ "z.string().max(5)": "_z0 = _str.max(5) (0)" })
	})

	it("orders shared bases by use, most used first", () => {
		const result = shared([
			table("a", ["z.number()", "z.boolean()", "z.boolean()", "z.boolean()"]),
			table("b", ["z.number()"]),
		])
		expect(Object.values(result)).toEqual(["_z0 = _bool (3)", "_z1 = _num (2)"])
	})

	it("never shares what names an import, matched as a whole identifier", () => {
		const roles = "z.enum(ROLES)"
		expect(shared([table("a", [roles, roles, roles])], ["ROLES"])).toEqual({})
		const lookalike = "z.enum(MY_ROLES)"
		expect(Object.keys(shared([table("a", [lookalike, lookalike, lookalike])], ["ROLES"]))).toEqual([lookalike])
	})
})

describe("rewriteBaseTypes and rewriteWithShared", () => {
	it("replace a base constructor with its alias", () => {
		expect(rewriteBaseTypes("z.number().int().nonnegative().max(9)")).toBe("_intNN.max(9)")
		expect(rewriteBaseTypes("schema.optional()")).toBe("schema.optional()")
	})

	it("reuse the largest shared layer, then chain what is left", () => {
		const s = buildSharedSchemas(
			[
				table("a", ["z.string().max(9)", "z.string().max(9).nullable()"]),
				table("b", ["z.string().max(9)", "z.string().max(4).meta(_m.x)"]),
				table("c", ["z.string().max(4).meta(_m.y)"]),
			],
			imports(),
		)
		expect(rewriteWithShared("z.string().max(9)", s)).toBe("_z0")
		expect(rewriteWithShared("z.string().max(9).nullable()", s)).toBe("_z1")
		expect(rewriteWithShared("z.string().max(9).nullable().optional()", s)).toBe("_z1.optional()")
		expect(rewriteWithShared("z.string().max(9).optional()", s)).toBe("_z0.optional()")
		expect(rewriteWithShared("z.string().max(4).meta(_m.z).nullable()", s)).toBe("_z2.meta(_m.z).nullable()")
		expect(rewriteWithShared("z.string().max(7).meta(_m.z)", s)).toBe("_str.max(7).meta(_m.z)")
		expect(rewriteWithShared("z.number().meta((x))", new Map())).toBe("_num.meta((x))")
		expect(rewriteWithShared("z.number().meta(unclosed", new Map())).toBe("_num.meta(unclosed")
	})
})

describe("shared-schemas: remaining layers", () => {
	it("chains .nullable() on a shared base that has no shared nullable variant", () => {
		const s = buildSharedSchemas([table("a", ["z.number()", "z.number()", "z.number()"])], imports())
		expect(rewriteWithShared("z.number().nullable()", s)).toBe("_z0.nullable()")
	})

	it("does not share a structural core only one table uses", () => {
		expect(shared([table("a", ['z.string().max(5).meta({ examples: ["a"] })'])])).toEqual({})
	})
})
