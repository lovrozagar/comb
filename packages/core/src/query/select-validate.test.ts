import { describe, expect, it } from "vitest"
import type * as z from "zod"
import { createListQuerySchema } from "./list-schema.ts"
import { createRetrieveQuerySchema } from "./retrieve-schema.ts"
import { validateSelectWithConfig } from "./select-validate.ts"

describe("select names that are Object.prototype members (Q-M2)", () => {
	const list = createListQuerySchema({
		fields: { relationFields: { author: ["name"] }, relations: ["author"], scalars: ["id"] },
		sort: ["id"],
	})
	const retrieve = createRetrieveQuerySchema({ fields: { relations: ["author"], scalars: ["id"] } })

	it.each([
		"__proto__(id)",
		"constructor(id)",
		"toString(name)",
		"author(__proto__(x))",
		"author(secret(x))",
		"valueOf",
	])("%s is an issue, not a thrown TypeError", (select) => {
		expect(list.safeParse({ select }).success).toBe(false)
		expect(retrieve.safeParse({ select }).success).toBe(false)
	})
})

describe("select with an embed that has no name", () => {
	it("is a 400 and returns", () => {
		const schema = createListQuerySchema({ fields: { scalars: ["id"] }, sort: ["id"] })
		expect(schema.safeParse({ select: "id,(x)" }).success).toBe(false)
	})
})

describe("validateSelectWithConfig", () => {
	const config = {
		relationFields: { author: ["name", "bio"] },
		relations: ["author", "tags"],
		scalars: ["id", "title"],
	}

	/** The parsed selection and the issue messages it raised */
	function run(select: string | undefined) {
		const issues: string[] = []
		const ctx = { addIssue: (issue: { message: string }) => issues.push(issue.message) } as unknown as z.RefinementCtx
		return { issues, parsed: validateSelectWithConfig(select, config, ctx) }
	}

	it("is null with no issue for no select, or only whitespace", () => {
		expect(run(undefined)).toEqual({ issues: [], parsed: null })
		expect(run("  ")).toEqual({ issues: [], parsed: null })
	})

	it("reports a select that does not parse", () => {
		expect(run("(x)")).toEqual({ issues: ["Invalid select syntax"], parsed: null })
	})

	it("expands wildcards to what the config declares, at the root and in a relation", () => {
		const { issues, parsed } = run("*,author(*)")
		expect(issues).toEqual([])
		expect(parsed?.root.scalars).toEqual(["id", "title"])
		expect(parsed?.root.relations["author"]?.scalars).toEqual(["name", "bio"])
	})

	it("treats every relation as undeclared when the config names none", () => {
		const issues: string[] = []
		const ctx = { addIssue: (issue: { message: string }) => issues.push(issue.message) } as unknown as z.RefinementCtx
		validateSelectWithConfig("id,author(name)", { scalars: ["id"] }, ctx)
		expect(issues).toEqual(["Unknown relation: author"])
	})

	it("lets computed fields through and reports every undeclared name", () => {
		expect(run("id,@score,nope,author(name,@rank,age),tags(anything),posts(id),author(books(id))").issues).toEqual([
			"Unknown field: nope",
			"Unknown author relation: books",
			"Unknown author field: age",
			"Unknown relation: posts",
		])
	})
})
