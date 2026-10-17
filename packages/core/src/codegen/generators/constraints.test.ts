import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { generateConstraints } from "./constraints.ts"
import { testContext } from "./__fixtures__/context.ts"

const HEAD = `import { sql } from "drizzle-orm"
import { sqliteTable as createTable, text, integer, check, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey(), text: (name: string) => text(name) }
`

let tmpDir: string

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-constraints-"))
})

afterEach(() => {
	fs.rmSync(tmpDir, { force: true, recursive: true })
})

/** Generate the constraint map for a tables source; returns the file and the logged lines */
function generate(tables: string): { content: string; logged: string[] } {
	const fp = path.join(tmpDir, "db.test.tables.ts")
	fs.writeFileSync(fp, `${HEAD}${tables}\n`)
	const ctx = testContext(analyze(fp), { cwd: tmpDir })
	const output = path.join(tmpDir, "constraints.gen.ts")
	generateConstraints(ctx, { output })
	return { content: fs.readFileSync(output, "utf-8"), logged: ctx.logged }
}

const checkFor = (name: string, expression = "length(x) <= 10") =>
	generate(`export const doc = createTable("doc", { id: c.id(), x: c.text("x") }, (t) => [
	check("${name}", sql\`${expression}\`),
])`).content

describe("generateConstraints — the written map", () => {
	it("writes the whole map: tables, groups and columns sorted, a comma after all but the last", () => {
		const { content } =
			generate(`export const user = createTable("user", { id: c.id(), email: c.text("email").unique() })
export const post = createTable("post", {
	id: c.id(),
	user_id: c.text("user_id").references(() => user.id),
}, (t) => [check("post_x_enum", sql\`x IN ('a')\`)])`)
		expect(content.slice(content.indexOf("\n") + 1)).toBe(`export const TEST_DB_CONSTRAINT_MAP = {
	/* post table constraints */
	post: {
		/* check constraints */
		check: {
			post_x_enum: {
				errorKey: "post_post_x_enum_failed",
				cause: "Invalid enum value",
				statusKey: "bad_request",
			}
		},
		/* foreign key constraints */
		foreignKey: {
			user_id: {
				errorKey: "post_user_id_reference_not_found",
				cause: "Referenced record does not exist",
				statusKey: "conflict",
			}
		},
		/* primary key constraint */
		primaryKey: {
			errorKey: "post_id_duplicate",
			cause: "Record with this ID already exists",
			statusKey: "conflict",
		}
	},
	/* user table constraints */
	user: {
		/* primary key constraint */
		primaryKey: {
			errorKey: "user_id_duplicate",
			cause: "Record with this ID already exists",
			statusKey: "conflict",
		},
		/* unique constraints */
		unique: {
			email: {
				errorKey: "user_email_duplicate",
				cause: "A record with this email value already exists",
				statusKey: "conflict",
			}
		}
	}
} as const
`)
	})
})

describe("generateConstraints", () => {
	it("logs the tables and the constraints it counted", () => {
		const { logged } =
			generate(`export const user = createTable("user", { id: c.id(), email: c.text("email").unique() })
export const audit = createTable("audit", { user_id: c.text("user_id").references(() => user.id) })`)
		expect(logged[0]).toMatch(/^Generated constraint map for test database at: .*constraints\.gen\.ts$/)
		expect(logged[1]).toBe("Tables: 2, Total constraints: 3")
	})

	it("leaves out a table with no constraint", () => {
		const { content } = generate(`export const log = createTable("log", { msg: c.text("msg") })`)
		expect(content).toContain("TEST_DB_CONSTRAINT_MAP")
		expect(content).not.toContain("log:")
	})

	it("stamps a composite primary key", () => {
		const { content } = generate(`export const pair = createTable("pair", { a: c.text("a"), b: c.text("b") }, (t) => [
	primaryKey({ columns: [t.a, t.b] }),
])`)
		expect(content).toContain("pair_id_duplicate")
	})
})

describe("generateConstraints — unique indexes", () => {
	it("keys an indexed column by its SQL name and its error key by the property", () => {
		const { content } =
			generate(`export const user = createTable("user", { id: c.id(), handle: c.text("handle_name") }, (t) => [
	uniqueIndex("user_handle_idx").on(t.handle),
])`)
		expect(content).toContain(`handle_name: {\n\t\t\t\terrorKey: "user_handle_duplicate",`)
	})

	it("keeps the index's own column name when no field declares it", () => {
		const { content } = generate(`export const user = createTable("user", { id: c.id() }, (t) => [
	uniqueIndex("user_ghost_idx").on(t.ghost),
])`)
		expect(content).toContain(`ghost: {\n\t\t\t\terrorKey: "user_ghost_duplicate",`)
	})
})

describe("generateConstraints — check-constraint classification", () => {
	it("reads an _enum check as an invalid enum value, at 400", () => {
		expect(checkFor("doc_status_enum")).toContain(`cause: "Invalid enum value",\n\t\t\t\tstatusKey: "bad_request"`)
	})

	it("turns a _size check into a human byte limit", () => {
		expect(checkFor("doc_body_size", "length(x) <= 2048")).toContain(
			`cause: "Exceeds maximum size of 2KB",\n\t\t\t\tstatusKey: "bad_request"`,
		)
	})

	it("keeps the generic size message when no limit can be read", () => {
		expect(checkFor("doc_body_size", "length(x) > 0")).toContain(
			`cause: "Check constraint violated",\n\t\t\t\tstatusKey: "conflict"`,
		)
	})

	it("reads expiry and valid checks as date constraints", () => {
		expect(checkFor("doc_expiry_check")).toContain("Invalid date/time constraint")
		expect(checkFor("doc_valid_range")).toContain(
			`cause: "Invalid date/time constraint",\n\t\t\t\tstatusKey: "bad_request"`,
		)
	})

	it("reads an integrity check as a data integrity failure, staying at conflict", () => {
		expect(checkFor("doc_integrity_check")).toContain(
			`cause: "Data integrity constraint violated",\n\t\t\t\tstatusKey: "conflict"`,
		)
	})

	it("falls back to the generic message and conflict for an unclassified check", () => {
		expect(checkFor("doc_something_else")).toContain(
			`cause: "Check constraint violated",\n\t\t\t\tstatusKey: "conflict"`,
		)
	})
})
