import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { constraintsOf, refuseJsonDocument, statesOf, STRING_LIST } from "./read-comb.ts"

describe("STRING_LIST", () => {
	it("holds an array of strings alone", () => {
		expect(STRING_LIST(["a", "b"])).toBe(true)
		expect(STRING_LIST([])).toBe(true)
		expect(STRING_LIST(["a", 1])).toBe(false)
		expect(STRING_LIST("a")).toBe(false)
	})
})

/* F60: a bound JSON cannot carry would reach the snapshot as null and drop without a word */
describe("constraintsOf: a number that is no finite number", () => {
	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"refuses %s, naming the column and the key",
		(max) => {
			expect(() => constraintsOf({ max }, "t.c")).toThrow(
				`t.c: the constraint max is ${max}, no finite number; a bound read from the environment is NaN in codegen's child, which has none of it`,
			)
		},
	)
})

describe("constraintsOf", () => {
	it("keeps every primitive, drops an undefined one, and reads none as empty", () => {
		expect(constraintsOf({ max: 3, pattern: "/a/", private: true, trim: undefined }, "t.c")).toEqual({
			max: 3,
			pattern: "/a/",
			private: true,
		})
		expect(constraintsOf(undefined, "t.c")).toEqual({})
	})

	it("refuses any other value, naming the column and the constraint", () => {
		expect(() => constraintsOf({ max: {} }, "t.c")).toThrow(
			"t.c: the constraint max is a object; comb reads a boolean, a number or a string",
		)
	})
})

describe("statesOf", () => {
	it("reads no machine as null, and each part it leaves out as null", () => {
		expect(statesOf(undefined, "t.c")).toBeNull()
		expect(statesOf({}, "t.c")).toEqual({ initial: null, terminal: null, transitions: null })
		expect(statesOf({ initial: "a", terminal: ["b"], transitions: { a: ["b"] } }, "t.c")).toEqual({
			initial: "a",
			terminal: ["b"],
			transitions: { a: ["b"] },
		})
	})

	it("refuses a machine of another shape, naming the column", () => {
		for (const raw of [{ initial: 1 }, { terminal: "b" }, { transitions: { a: "b" } }])
			expect(() => statesOf(raw, "t.c")).toThrow("t.c: its state machine is not")
	})

	/* F9 of the 0.14.1 review: a misspelt key would leave its part of the machine unread */
	it("refuses a key no state machine has, naming the column and the key", () => {
		expect(() => statesOf({ inital: "a" }, "t.c")).toThrow(
			"t.c: its state machine has inital, which is none of initial, terminal, transitions and values",
		)
	})
})

/* CD2, CD3 of r22b: a c.json schema is the stored document */
describe("refuseJsonDocument: a schema whose output its input refuses, or a NOT NULL one that takes null", () => {
	const STORED = "t.c: a c.json schema is the stored document"
	type Tree = { children: Tree[]; name: string }
	const tree: z.ZodType<Tree> = z.lazy(() => z.object({ children: z.array(tree), name: z.string().trim() }))
	const changing: z.ZodType = z.lazy(() =>
		z.object({ next: z.array(changing).optional(), n: z.string().transform(Number) }),
	)

	it.each([
		["a transform", z.string().transform((text) => text.length)],
		["a pipe", z.string().pipe(z.coerce.number())],
		["a preprocess", z.preprocess(String, z.string())],
		["a transform in a shape's field", z.object({ a: z.object({ b: z.string().transform(Number) }) })],
		["a transform in a union's option", z.union([z.number(), z.string().transform(Number)])],
		["a transform in a recursive lazy", changing],
	])("refuses %s, naming the column", (_, schema) => {
		expect(() => refuseJsonDocument(schema, "t.c", false)).toThrow(STORED)
	})

	it.each([
		["an overwrite", z.object({ name: z.string().trim().toLowerCase().normalize() })],
		["a default", z.object({ n: z.number().default(1) })],
		["a coerce", z.object({ n: z.coerce.number() })],
		["a refine", z.string().refine((text) => text !== "x")],
		["a recursive lazy of overwrites", tree],
	])("keeps %s, whose output parses again", (_, schema) => {
		expect(() => refuseJsonDocument(schema, "t.c", true)).not.toThrow()
	})

	it("refuses a schema that takes null on a NOT NULL column, and keeps it on a nullable one (sibling)", () => {
		const nullable = z.object({ a: z.string() }).nullable()
		expect(() => refuseJsonDocument(nullable, "t.c", true)).toThrow(
			"t.c: its schema takes null and the column is NOT NULL: make the column nullable, or pass the schema's non-null form",
		)
		expect(() => refuseJsonDocument(nullable, "t.c", false)).not.toThrow()
		expect(() => refuseJsonDocument(z.unknown(), "t.c", true)).toThrow("takes null")
	})
})

/* CD4 of r22b: a state column's fill is its machine's initial */
const MACHINE = { initial: "a", terminal: ["b"] }
const NO_LITERAL =
	't.s: its default is no literal value, so comb cannot hold it to its state machine\'s initial "a"; write .default("a")'

describe("statesOf: a state column's default is its initial", () => {
	it("keeps any fill on a machine that declares no initial (sibling)", () => {
		expect(() => statesOf({ terminal: ["b"] }, "t.s", { default: "b" })).not.toThrow()
		expect(() => statesOf({ terminal: ["b"] }, "t.s", { defaultFn: () => "b" })).not.toThrow()
	})

	it("keeps no default, and a literal default of initial", () => {
		expect(statesOf(MACHINE, "t.s", {})?.initial).toBe("a")
		expect(statesOf(MACHINE, "t.s", { default: "a" })?.initial).toBe("a")
	})

	it("refuses a literal default other than initial, naming the column", () => {
		expect(() => statesOf(MACHINE, "t.s", { default: "b" })).toThrow(
			't.s: its default "b" is not its state machine\'s initial "a"; a row starts at initial',
		)
	})

	it.each([
		["a default function", { defaultFn: () => "a" }],
		["an update function", { onUpdateFn: () => "a" }],
		["an SQL default", { default: sql`'a'` }],
	])("refuses %s, which comb cannot read as a value", (_, fill) => {
		expect(() => statesOf(MACHINE, "t.s", fill)).toThrow(NO_LITERAL)
	})
})
