import { SyntaxKind } from "ts-morph"
import { describe, expect, it } from "vitest"
import { textWithoutComments } from "./node-text.ts"
import { createProject } from "./ts-morph.ts"

function columnText(source: string): string {
	const file = createProject().createSourceFile("x.ts", `const t = { col: ${source} }`)
	const value = file.getFirstDescendantByKindOrThrow(SyntaxKind.PropertyAssignment).getInitializerOrThrow()
	return textWithoutComments(value)
}

describe("textWithoutComments", () => {
	it("drops line and block comments anywhere inside the expression", () => {
		expect(columnText('c.text("t") // TODO: .notNull()\n\t.default("x")')).toBe('c.text("t") \n\t.default("x")')
		expect(columnText('c.text("t") /* .primaryKey() */ .notNull()')).toBe('c.text("t")  .notNull()')
		expect(columnText('c.text(/* name */ "t", { max: 5 /* chars */ })')).toBe('c.text( "t", { max: 5  })')
	})

	it("keeps comment-like text inside strings", () => {
		expect(columnText('c.text("t", { pattern: "^//x/*y*/$" })')).toBe('c.text("t", { pattern: "^//x/*y*/$" })')
	})

	it("returns code without comments unchanged", () => {
		expect(columnText('c.text("t").notNull()')).toBe('c.text("t").notNull()')
	})
})
