import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { ImportsMeta } from "../../analyzer-types.ts"
import type { FieldInfo, TableInfo } from "./dto-types.ts"
import { buildSharedSchemas, rewriteBaseTypes, rewriteWithShared } from "./shared-schemas.ts"

function table(name: string, zodTypes: string[]): TableInfo {
	const fields: FieldInfo[] = zodTypes.map((zodType, i) => ({ key: `f${i}`, type: "read", uses: [], zodType }))
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
	/* F59: sharing turns on the schema alone, never on how often tables use it */
	it("shares every core that is more than an alias, whatever its use, with the variants in use", () => {
		const s = "z.string().max(10)"
		expect(
			shared([table("a", [s, `${s}.nullable()`, `${s}.nullable().optional()`]), table("b", [`${s}.optional()`])]),
		).toEqual({
			[s]: `${n(s)} = _str.max(10) (1)`,
			[`${s}.nullable()`]: `${n(`${s}.nullable()`)} = ${n(s)}.nullable() (1)`,
			[`${s}.nullable().optional()`]: `${n(`${s}.nullable().optional()`)} = ${n(`${s}.nullable()`)}.optional() (1)`,
			[`${s}.optional()`]: `${n(`${s}.optional()`)} = ${n(s)}.optional() (1)`,
		})
		expect(shared([table("a", [s])])).toEqual({ [s]: `${n(s)} = _str.max(10) (1)` })
		/* an alias the shared file already names is used as itself */
		expect(shared([table("a", ["z.number()", "z.number()"]), table("b", ["z.number()"])])).toEqual({})
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

	it("orders shared cores by their code, never by use", () => {
		const result = shared([table("a", ["z.string().max(9)", "z.string().max(10)", "z.string().max(10)"])])
		expect(Object.keys(result)).toEqual(["z.string().max(10)", "z.string().max(9)"])
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
		expect(rewriteWithShared("z.string().max(9)", s).code).toBe(max9)
		expect(rewriteWithShared("z.string().max(9).nullable()", s).code).toBe(max9Null)
		expect(rewriteWithShared("z.string().max(9).nullable().optional()", s).code).toBe(`${max9Null}.optional()`)
		expect(rewriteWithShared("z.string().max(9).optional()", s).code).toBe(`${max9}.optional()`)
		expect(rewriteWithShared("z.string().max(4).meta(_m.z).nullable()", s).code).toBe(`${max4}.meta(_m.z).nullable()`)
		expect(rewriteWithShared("z.string().max(7).meta(_m.z)", s).code).toBe("_str.max(7).meta(_m.z)")
		expect(rewriteWithShared("z.number().meta((x))", new Map()).code).toBe("_num.meta((x))")
		expect(rewriteWithShared("z.number().meta(unclosed", new Map()).code).toBe("_num.meta(unclosed")
	})

	/* C3 of r21: the names are what the code holds, a substituted core holding its builder's own */
	it("names the shared schema it substituted alone, or else what the field uses and its alias", () => {
		const base = "z.union([jsonValueSchema.refine(f)])"
		const s = buildSharedSchemas([table("a", [`${base}.nullable().optional()`])], imports())
		const full = n(`${base}.nullable().optional()`)
		expect(rewriteWithShared(`${base}.nullable().optional()`, s, ["jsonValueSchema"])).toEqual({
			code: full,
			names: [full],
		})
		expect(rewriteWithShared("jsonValueSchema.nullable()", new Map(), ["jsonValueSchema"]).names).toEqual([
			"jsonValueSchema",
		])
		expect(rewriteWithShared("z.string().max(7)", new Map(), []).names).toEqual(["_str"])
	})
})

describe("shared-schemas: remaining layers", () => {
	it("chains .nullable() on a shared base that has no shared nullable variant", () => {
		const s = buildSharedSchemas([table("a", ["z.number().max(5)"])], imports())
		expect(rewriteWithShared("z.number().max(5).nullable()", s).code).toBe(`${n("z.number().max(5)")}.nullable()`)
	})

	/* F59: a field's own meta, an id's prefixed example among them, stays in its table's file */
	it("shares the core one table uses, and leaves its meta inline", () => {
		const withMeta = 'z.string().max(5).meta({ examples: ["a"] })'
		const s = buildSharedSchemas([table("a", [withMeta])], imports())
		expect([...s.keys()]).toEqual(["z.string().max(5)"])
		expect(rewriteWithShared(withMeta, s).code).toBe(`${n("z.string().max(5)")}.meta({ examples: ["a"] })`)
	})

	/* C1 of r20: a nullable field's keys sit on its member and on the nullable, so `.unwrap()` keeps them */
	it("shares the core of a field whose keys sit on its member too, and no variant it never uses", () => {
		const keys = '.meta({"x-comb-maxLength":5})'
		const field = `z.string().max(5)${keys}.nullable()${keys}`
		const s = buildSharedSchemas([table("a", [field, `${field}.optional()`])], imports())
		expect([...s.keys()]).toEqual(["z.string().max(5)"])
		expect(rewriteWithShared(field, s).code).toBe(`${n("z.string().max(5)")}${keys}.nullable()${keys}`)
		expect(rewriteWithShared(`${field}.optional()`, s).code).toBe(
			`${n("z.string().max(5)")}${keys}.nullable()${keys}.optional()`,
		)
		const example = `z.string().max(5).meta(_m.string)${keys}.nullable()${keys}`
		expect(rewriteWithShared(example, s).code).toBe(
			`${n("z.string().max(5)")}.meta(_m.string)${keys}.nullable()${keys}`,
		)
	})

	it("keeps an array whose elements carry the meta whole, never cut at that inner meta", () => {
		const array = 'z.array(z.string().meta({ examples: ["a"] }).nullable())'
		const s = buildSharedSchemas([table("a", [array])], imports())
		expect([...s.keys()]).toEqual([array])
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
