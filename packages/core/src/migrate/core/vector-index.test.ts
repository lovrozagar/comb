import { describe, expect, it } from "vitest"
import { isVectorIndexSql, vectorShadows, vectorStatement } from "./vector-index.ts"

describe("isVectorIndexSql", () => {
	it("is an index on a libsql_vector_idx call, in any case and spacing", () => {
		expect(isVectorIndexSql("CREATE INDEX t_emb ON t (libsql_vector_idx(emb))")).toBe(true)
		expect(isVectorIndexSql("CREATE INDEX t_emb ON t (LIBSQL_VECTOR_IDX (emb, 'metric=cosine'))")).toBe(true)
		expect(isVectorIndexSql("CREATE INDEX t_v ON t (v)")).toBe(false)
	})
})

describe("vectorShadows", () => {
	it("is nothing for no vector index, and each one's shadow table and index with libsql's table of them", () => {
		expect(vectorShadows([])).toEqual(new Set())
		expect(vectorShadows(["t_emb", "U_Vec"])).toEqual(
			new Set(["t_emb_shadow", "t_emb_shadow_idx", "u_vec_shadow", "u_vec_shadow_idx", "libsql_vector_meta_shadow"]),
		)
	})
})

describe("vectorStatement", () => {
	it("is a statement that makes a vector index, by any spelling of its name, and remembers the name", () => {
		const made = new Set<string>()
		expect(vectorStatement("CREATE INDEX t_emb ON t (libsql_vector_idx(emb))", made)).toBe(true)
		expect(
			vectorStatement('-- vectors\n/* note */ CREATE INDEX IF NOT EXISTS "Q Emb" ON t (libsql_vector_idx(emb))', made),
		).toBe(true)
		expect(vectorStatement("CREATE INDEX main.[b_emb] ON t (libsql_vector_idx(emb))", made)).toBe(true)
		expect(vectorStatement("CREATE INDEX `c_emb` ON t (libsql_vector_idx(emb))", made)).toBe(true)
		expect(made).toEqual(new Set(["t_emb", "q emb", "b_emb", "c_emb"]))
	})

	it("is a drop of a vector index an earlier statement made, and forgets it; nothing else", () => {
		const made = new Set(["t_emb"])
		expect(vectorStatement("CREATE INDEX t_v ON t (v)", made)).toBe(false)
		expect(vectorStatement("DROP INDEX t_v", made)).toBe(false)
		expect(vectorStatement("CREATE TABLE libsql_vector_idx_calls (a)", made)).toBe(false)
		expect(vectorStatement("DROP INDEX IF EXISTS main.T_EMB", made)).toBe(true)
		expect(made).toEqual(new Set())
		expect(vectorStatement("DROP INDEX t_emb", made)).toBe(false)
	})
})
