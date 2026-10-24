import { createHash } from "node:crypto"
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

/** The name a shared schema takes: from its own code, so another table's columns never rename it (F35) */
const n = (zodType: string) => `_z_${createHash("sha256").update(zodType).digest("hex").slice(0, 8)}`

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
			[s]: `${n(s)} = _str.max(10) (1)`,
			[`${s}.nullable()`]: `${n(`${s}.nullable()`)} = ${n(s)}.nullable() (1)`,
			[`${s}.nullable().optional()`]: `${n(`${s}.nullable().optional()`)} = ${n(`${s}.nullable()`)}.optional() (1)`,
			[`${s}.optional()`]: `${n(`${s}.optional()`)} = ${n(s)}.optional() (1)`,
		})
		expect(shared([table("a", ["z.number()"]), table("b", ["z.number()"])])).toEqual({
			"z.number()": `${n("z.number()")} = _num (2)`,
		})
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
		expect(result).toEqual({ "z.string().max(5)": `${n("z.string().max(5)")} = _str.max(5) (0)` })
	})

	it("orders shared bases by use, most used first", () => {
		const result = shared([
			table("a", ["z.number()", "z.boolean()", "z.boolean()", "z.boolean()"]),
			table("b", ["z.number()"]),
		])
		expect(Object.values(result)).toEqual([`${n("z.boolean()")} = _bool (3)`, `${n("z.number()")} = _num (2)`])
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
		const [max9, max9Null, max4] = [n("z.string().max(9)"), n("z.string().max(9).nullable()"), n("z.string().max(4)")]
		expect(rewriteWithShared("z.string().max(9)", s)).toBe(max9)
		expect(rewriteWithShared("z.string().max(9).nullable()", s)).toBe(max9Null)
		expect(rewriteWithShared("z.string().max(9).nullable().optional()", s)).toBe(`${max9Null}.optional()`)
		expect(rewriteWithShared("z.string().max(9).optional()", s)).toBe(`${max9}.optional()`)
		expect(rewriteWithShared("z.string().max(4).meta(_m.z).nullable()", s)).toBe(`${max4}.meta(_m.z).nullable()`)
		expect(rewriteWithShared("z.string().max(7).meta(_m.z)", s)).toBe("_str.max(7).meta(_m.z)")
		expect(rewriteWithShared("z.number().meta((x))", new Map())).toBe("_num.meta((x))")
		expect(rewriteWithShared("z.number().meta(unclosed", new Map())).toBe("_num.meta(unclosed")
	})
})

describe("shared-schemas: remaining layers", () => {
	it("chains .nullable() on a shared base that has no shared nullable variant", () => {
		const s = buildSharedSchemas([table("a", ["z.number()", "z.number()", "z.number()"])], imports())
		expect(rewriteWithShared("z.number().nullable()", s)).toBe(`${n("z.number()")}.nullable()`)
	})

	it("does not share a structural core only one table uses", () => {
		expect(shared([table("a", ['z.string().max(5).meta({ examples: ["a"] })'])])).toEqual({})
	})
})

/** The 16-hex name a schema takes when another shares its first 8 */
const long = (zodType: string) => `_z_${createHash("sha256").update(zodType).digest("hex").slice(0, 16)}`
const nameOf = (tables: TableInfo[], zodType: string) => buildSharedSchemas(tables, imports()).get(zodType)?.name

/* the 0.12 review's F35: a name comes from the schema's own code; two whose sha256 share the first 8
   hex digits (a real pair, found by search) both take 16, so neither name depends on which is used more */
describe("buildSharedSchemas: two schemas whose 8 hex digits collide", () => {
	const A = "z.string().max(34540)"
	const B = "z.string().max(86368)"

	it("collide in their first 8 hex digits and differ in 16", () => {
		expect(n(A)).toBe(n(B))
		expect(long(A)).not.toBe(long(B))
	})

	it("give both 16 hex digits, whichever is used more", () => {
		for (const [more, less] of [
			[A, B],
			[B, A],
		] as const) {
			const tables = [table("a", [more, more, more, less]), table("b", [less])]
			expect(nameOf(tables, A)).toBe(long(A))
			expect(nameOf(tables, B)).toBe(long(B))
		}
	})

	it("chain each variant on its base's 16-digit name, and leave a schema no other collides with at 8", () => {
		const s = "z.string().max(10)"
		const result = shared([table("a", [A, `${A}.nullable()`, B, B, B, s, s]), table("b", [A, s])])
		expect(result[`${A}.nullable()`]).toBe(`${n(`${A}.nullable()`)} = ${long(A)}.nullable() (1)`)
		expect(result[s]).toBe(`${n(s)} = _str.max(10) (3)`)
	})
})
