import { describe, expect, it } from "vitest"
import { readTableOptions } from "./analyze-options.ts"
import { createProject } from "./utils/ts-morph.ts"

/** readTableOptions on the third argument of the table in `source`. */
function optionsOf(source: string) {
	const file = createProject().createSourceFile("x.ts", source)
	const node = file.getFirstDescendant((n) => n.getKindName() === "ArrowFunction")
	return readTableOptions(node)
}

describe("readTableOptions", () => {
	it("reads composite keys, plain unique indexes and CHECKs from the array form", () => {
		expect(
			optionsOf(`const t = sqliteTable("t", {}, (x) => [
	primaryKey({ columns: [x.a, x.b] }),
	uniqueIndex("t_a_b").on(x.a, x.b),
	check("t_n_pos", sql\`
		n >   0
	\`),
	index("t_c").on(x.c),
])`),
		).toEqual({
			checkConstraints: [{ expression: "n > 0", name: "t_n_pos" }],
			hasCompositePrimaryKey: true,
			partialUniqueIndexes: [],
			uniqueIndexes: [{ columns: ["a", "b"], name: "t_a_b" }],
		})
	})

	it("reads the object form and a body in parentheses", () => {
		expect(
			optionsOf(`const t = sqliteTable("t", {}, (t) => ({ ...shared, u: uniqueIndex("t_u").on(t.u), x: other }))`),
		).toEqual({
			checkConstraints: [],
			hasCompositePrimaryKey: false,
			partialUniqueIndexes: [],
			uniqueIndexes: [{ columns: ["u"], name: "t_u" }],
		})
	})

	it("keeps a partial unique index apart and leaves out expression indexes and malformed calls", () => {
		const options = optionsOf(`const t = sqliteTable("t", {}, (t) => [
	uniqueIndex("lower_email").on(sql\`lower(\${t.email})\`),
	uniqueIndex("live_slug").on(t.slug).where(sql\`deleted_at is null\`),
	uniqueIndex("other_table").on(u.x),
	uniqueIndex("no_columns").on(),
	uniqueIndex(name).on(t.a),
	uniqueIndex("no_on"),
	check("no_sql", "n > 0"),
	check(name, sql\`n > 0\`),
])`)
		expect(options).toEqual({
			checkConstraints: [],
			hasCompositePrimaryKey: false,
			partialUniqueIndexes: [{ columns: ["slug"], name: "live_slug" }],
			uniqueIndexes: [],
		})
	})

	it("is empty without an arrow function or an option list", () => {
		expect(optionsOf(`const t = sqliteTable("t", {})`)).toEqual({
			checkConstraints: [],
			hasCompositePrimaryKey: false,
			partialUniqueIndexes: [],
			uniqueIndexes: [],
		})
		expect(optionsOf(`const t = sqliteTable("t", {}, () => buildOptions())`).uniqueIndexes).toEqual([])
	})
})
