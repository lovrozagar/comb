import { SyntaxKind } from "ts-morph"
import { describe, expect, it } from "vitest"
import { readEnum } from "./enum-source.ts"
import { createProject } from "./ts-morph.ts"

/** readEnum on the `status` column of a table in `source`, with `files` beside it. */
function readStatus(source: string, files: Record<string, string> = {}) {
	const project = createProject()
	for (const [name, text] of Object.entries(files)) project.createSourceFile(`/app/${name}`, text)
	const file = project.createSourceFile("/app/db.x.tables.ts", source)
	const column = file
		.getDescendantsOfKind(SyntaxKind.PropertyAssignment)
		.find((p) => p.getName() === "status")
		?.getInitializer()
	if (column === undefined) throw new Error("no status column")
	return readEnum(column)
}

const table = (column: string, before = "") => `${before}\nexport const t = sqliteTable("t", { status: ${column} })`

const MACHINE = `{ initial: "queued", terminal: ["sent"], transitions: { queued: ["sending"], sending: ["sent"] } }`
const PARSED = { initial: "queued", terminal: ["sent"], transitions: { queued: ["sending"], sending: ["sent"] } }

describe("readEnum: values", () => {
	it.each([
		["an inline list", `c.enum("status", ["queued", "sending", "sent"])`],
		["a list with as const", `c.enum("status", ["queued", "sending", "sent"] as const)`],
		["a multi-line list", `c.enum("status", [\n\t"queued",\n\t"sending",\n\t"sent",\n])`],
		["a chained column", `c.enum("status", ["queued", "sending", "sent"]).notNull().default("queued")`],
	])("reads %s", (_name, column) => {
		expect(readStatus(`export const t = sqliteTable("t", { status: ${column} })`)).toEqual({
			machine: null,
			reference: null,
			values: ["queued", "sending", "sent"],
		})
	})

	it("resolves a local const, a const's .values and an imported const", () => {
		const local = `const VALUES = ["a", "b"] as const\nexport const t = sqliteTable("t", { status: c.enum("status", VALUES) })`
		expect(readStatus(local)?.values).toEqual(["a", "b"])
		const member = `const m = { values: ["a", "b"], initial: "a" } as const satisfies StateMachine\nexport const t = sqliteTable("t", { status: c.enum("status", m.values, m) })`
		expect(readStatus(member)).toEqual({
			machine: { initial: "a", terminal: null, transitions: null },
			reference: null,
			values: ["a", "b"],
		})
		const imported = `import { VALUES } from "./enums"\nexport const t = sqliteTable("t", { status: c.enum("status", VALUES) })`
		expect(readStatus(imported, { "enums.ts": `export const VALUES = ["x", "y"] as const` })?.values).toEqual([
			"x",
			"y",
		])
	})

	it("reads a text column typed by a const's element type", () => {
		const source = `const ROLES = ["admin", "user"] as const\nexport const t = sqliteTable("t", { status: c.text("status").$type<(typeof ROLES)[number]>() })`
		expect(readStatus(source)).toEqual({ machine: null, reference: null, values: ["admin", "user"] })
	})

	it("keeps the reference when the values cannot be read", () => {
		const source = `import { ROLES } from "@app/shared"\nexport const t = sqliteTable("t", { status: c.enum("status", ROLES) })`
		expect(readStatus(source)).toEqual({ machine: null, reference: "ROLES", values: null })
		const computed = `export const t = sqliteTable("t", { status: c.enum("status", ["a", other]) })`
		expect(readStatus(computed)).toEqual({ machine: null, reference: null, values: null })
	})

	it("is null for a column that is no enum", () => {
		expect(readStatus(`export const t = sqliteTable("t", { status: c.text("status") })`)).toBeNull()
	})
})

describe("readEnum: state machines", () => {
	it.each([
		["inline", `c.enum("status", ["queued", "sending", "sent"], ${MACHINE})`],
		["after as const values", `c.enum("status", ["queued", "sending", "sent"] as const, ${MACHINE})`],
	])("reads a machine written %s", (_name, column) => {
		expect(readStatus(`export const t = sqliteTable("t", { status: ${column} })`)?.machine).toEqual(PARSED)
	})

	it("resolves a machine held as a const and keeps dotted state names whole", () => {
		const source = `const deliveryStates = {
	values: ["queued", "payment.failed"],
	initial: "queued",
	terminal: ["payment.failed"],
	transitions: { queued: ["payment.failed"], "payment.failed": [] },
} as const satisfies StateMachine
export const t = sqliteTable("t", { status: c.enum("status", deliveryStates.values, deliveryStates) })`
		expect(readStatus(source)).toEqual({
			machine: {
				initial: "queued",
				terminal: ["payment.failed"],
				transitions: { "payment.failed": [], queued: ["payment.failed"] },
			},
			reference: null,
			values: ["queued", "payment.failed"],
		})
	})

	it("reads no machine from an object that names none of its keys", () => {
		expect(
			readStatus(`export const t = sqliteTable("t", { status: c.enum("status", ["a"], { other: 1 }) })`)?.machine,
		).toBeNull()
	})
})

describe("readEnum: what it cannot read", () => {
	it("gives up on cycles, unknown owners and non-literal parts", () => {
		expect(readStatus(table(`c.enum("status", A)`, "const A = B\nconst B = A"))?.values).toBeNull()
		expect(readStatus(table(`c.enum("status", unknown.values)`))).toEqual({
			machine: null,
			reference: null,
			values: null,
		})
		expect(readStatus(table(`c.text("status").$type<string>()`))).toBeNull()
		expect(readStatus(table(`c.text("status")`))).toBeNull()
	})

	it("reads what it can of a machine and skips the rest", () => {
		const machine = `{ initial: START, terminal: ENDS, transitions: MOVES, ...more, "quoted-key": 1 }`
		expect(readStatus(table(`c.enum("status", ["a"], ${machine})`))?.machine).toEqual({
			initial: null,
			terminal: null,
			transitions: null,
		})
		const partial = `{ transitions: { a: ["b"], b: OTHER, ...rest } }`
		expect(readStatus(table(`c.enum("status", ["a", "b"], ${partial})`))?.machine).toEqual({
			initial: null,
			terminal: null,
			transitions: { a: ["b"] },
		})
	})
})

describe("readEnum: edge shapes", () => {
	it("handles a call without values, a column that is no call, and an unreadable $type", () => {
		expect(readStatus(table(`c.enum("status")`))).toEqual({ machine: null, reference: null, values: null })
		expect(readStatus(table(`sharedStatus`))).toBeNull()
		const typed = table(`c.text("status").$type<(typeof ROLES)[number]>()`, `import { ROLES } from "@app/shared"`)
		expect(readStatus(typed)).toEqual({ machine: null, reference: "ROLES", values: null })
	})
})
