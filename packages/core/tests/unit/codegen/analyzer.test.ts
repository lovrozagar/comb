import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../../../src/codegen/analyzer.ts"

describe("analyzer", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-analyzer-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function writeTablesFile(content: string, filename = "db.test.tables.ts"): string {
		const fp = path.join(tmpDir, filename)
		fs.writeFileSync(fp, content)
		return fp
	}

	it("extracts basic table with fields", () => {
		const fp = writeTablesFile(`
import { sql } from "drizzle-orm"
import { sqliteTable as createTable, text, integer } from "drizzle-orm/sqlite-core"

const c = {
	id: () => text("id").primaryKey(),
	text: (name: string) => text(name),
	integer: (name: string) => integer(name, { mode: "number" }),
	createdAt: (name: string) => integer(name, { mode: "number" }).notNull(),
	updatedAt: (name: string) => integer(name, { mode: "number" }).notNull(),
}

export const user = createTable("user", {
	id: c.id(),
	name: c.text("name"),
	age: c.integer("age"),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
})
`)
		const result = analyze(fp)
		expect(result.dbName).toBe("test")
		expect(result.tables).toHaveLength(1)

		const table = result.tables[0]
		expect(table.varName).toBe("user")
		expect(table.sqlName).toBe("user")
		expect(table.fields).toHaveLength(5)

		const idField = table.fields.find((f) => f.name === "id")
		expect(idField?.isPrimaryKey).toBe(true)
		expect(idField?.drizzleHelper).toBe("id")

		const nameField = table.fields.find((f) => f.name === "name")
		expect(nameField?.drizzleHelper).toBe("text")
		expect(nameField?.isPrimaryKey).toBe(false)
	})

	it("detects timestamp fields and style", () => {
		const fp = writeTablesFile(`
import { sqliteTable as createTable, text, integer } from "drizzle-orm/sqlite-core"

const c = {
	id: () => text("id").primaryKey(),
	createdAt: (name: string) => integer(name, { mode: "number" }).notNull(),
	updatedAt: (name: string) => integer(name, { mode: "number" }).notNull(),
	deletedAt: (name: string) => integer(name, { mode: "number" }),
}

export const item = createTable("item", {
	id: c.id(),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
	deleted_at: c.deletedAt("deleted_at"),
})
`)
		const result = analyze(fp)
		const table = result.tables[0]
		expect(table.timestamps.createdAt).toBe(true)
		expect(table.timestamps.updatedAt).toBe(true)
		expect(table.timestamps.deletedAt).toBe(true)
		expect(table.timestamps.style).toBe("snake_case")
	})

	it("extracts unique indexes from table options", () => {
		const fp = writeTablesFile(`
import { sqliteTable as createTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

const c = {
	id: () => text("id").primaryKey(),
	text: (name: string) => text(name),
}

export const user = createTable("user", {
	id: c.id(),
	email: c.text("email").notNull(),
	slug: c.text("slug").notNull(),
}, (t) => [
	uniqueIndex("idx_user_email").on(t.email),
	uniqueIndex("idx_user_slug").on(t.slug),
])
`)
		const result = analyze(fp)
		const table = result.tables[0]
		expect(table.uniqueIndexes).toHaveLength(2)
		expect(table.uniqueIndexes[0]).toEqual({
			columns: ["email"],
			name: "idx_user_email",
		})
	})

	it("extracts check constraints", () => {
		const fp = writeTablesFile(`
import { sql } from "drizzle-orm"
import { sqliteTable as createTable, text, integer, check } from "drizzle-orm/sqlite-core"

const c = {
	id: () => text("id").primaryKey(),
	integer: (name: string) => integer(name, { mode: "number" }),
}

export const product = createTable("product", {
	id: c.id(),
	price: c.integer("price").notNull(),
}, (t) => [
	check("price_positive", sql\`price > 0\`),
])
`)
		const result = analyze(fp)
		const table = result.tables[0]
		expect(table.checkConstraints).toHaveLength(1)
		expect(table.checkConstraints[0].name).toBe("price_positive")
		expect(table.checkConstraints[0].expression).toBe("price > 0")
	})

	it("extracts FK references", () => {
		const fp = writeTablesFile(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"

const c = {
	id: () => text("id").primaryKey(),
	ref: (name: string) => text(name),
}

export const user = createTable("user", {
	id: c.id(),
})

export const post = createTable("post", {
	id: c.id(),
	author_id: c.ref("author_id").references(() => user.id, { onDelete: "cascade" }).notNull(),
})
`)
		const result = analyze(fp)
		const postTable = result.tables.find((t) => t.varName === "post")
		const fkField = postTable?.fields.find((f) => f.name === "author_id")
		expect(fkField?.foreignKey).toEqual({
			column: "author_id",
			onDelete: "cascade",
			refColumn: "id",
			refTable: "user",
		})
	})

	it("sorts tables alphabetically by varName", () => {
		const fp = writeTablesFile(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"

const c = {
	id: () => text("id").primaryKey(),
}

export const zebra = createTable("zebra", { id: c.id() })
export const alpha = createTable("alpha", { id: c.id() })
export const middle = createTable("middle", { id: c.id() })
`)
		const result = analyze(fp)
		expect(result.tables.map((t) => t.varName)).toEqual(["alpha", "middle", "zebra"])
	})

	it("extracts dbName from various file patterns", () => {
		expect(analyze(writeTablesFile("", "db.core.tables.ts")).dbName).toBe("core")
		expect(analyze(writeTablesFile("", "csvme.db.shard.tables.gen.ts")).dbName).toBe("shard")
		expect(analyze(writeTablesFile("", "tables.ts")).dbName).toBe("db")
	})

	it("extracts enum names", () => {
		const fp = writeTablesFile(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"

const ROLES = ["admin", "user"] as const

const c = {
	id: () => text("id").primaryKey(),
	enum: (name: string, values: readonly string[]) => text(name),
}

export const user = createTable("user", {
	id: c.id(),
	role: c.enum("role", ROLES),
})
`)
		const result = analyze(fp)
		const roleField = result.tables[0].fields.find((f) => f.name === "role")
		expect(roleField?.enumName).toBe("ROLES")
	})

	it("extracts a state machine declared as c.enum's third argument", () => {
		const fp = writeTablesFile(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	enum: (name: string, values: readonly string[], _s?: object) => text(name),
}
export const delivery = createTable("delivery", {
	id: c.id(),
	status: c.enum("status", ["queued", "sent"], { initial: "queued", terminal: ["sent"] }),
})
`)
		const result = analyze(fp)
		const status = result.tables[0]!.fields.find((f) => f.name === "status")
		expect(status?.enumValues).toEqual(["queued", "sent"])
		expect(status?.states).toEqual({
			initial: "queued",
			terminal: ["sent"],
			transitions: null,
		})
	})

	it("extracts field constraints", () => {
		const fp = writeTablesFile(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"

const c = {
	id: () => text("id").primaryKey(),
	text: (name: string, constraints?: { min?: number, max?: number, email?: boolean }) => text(name),
}

export const user = createTable("user", {
	id: c.id(),
	email: c.text("email", { min: 5, max: 254, email: true }),
})
`)
		const result = analyze(fp)
		const emailField = result.tables[0].fields.find((f) => f.name === "email")
		expect(emailField?.constraints.min).toBe(5)
		expect(emailField?.constraints.max).toBe(254)
		expect(emailField?.constraints.email).toBe(true)
		expect(emailField?.length).toBe(254)
	})
})

describe("analyze — referential actions", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-analyzer-fk-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function fkFor(options: string) {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey(), ref: (n: string) => text(n) }
export const author = createTable("author", { id: c.id() })
export const post = createTable("post", {
	id: c.id(),
	author_id: c.ref("author_id").references(() => author.id${options}),
})
`,
		)
		const analysis = analyze(fp)
		return analysis.tables.find((t) => t.sqlName === "post")?.fields.find((f) => f.name === "author_id")?.foreignKey
	}

	it("records the referenced table and column", () => {
		expect(fkFor("")).toMatchObject({ column: "author_id", refColumn: "id", refTable: "author" })
	})

	const actions = ["cascade", "restrict", "set null", "set default", "no action"]

	for (const action of actions) {
		it(`keeps the multi-word-safe onDelete value "${action}"`, () => {
			/* \\w+ silently dropped every value containing a space, so three of the
			   five drizzle referential actions never reached the generators. */
			expect(fkFor(`, { onDelete: "${action}" }`)?.onDelete).toBe(action)
		})
	}

	it("keeps onDelete and onUpdate together", () => {
		const fk = fkFor(`, { onDelete: "set null", onUpdate: "cascade" }`)
		expect(fk?.onDelete).toBe("set null")
		expect(fk?.onUpdate).toBe("cascade")
	})

	it("leaves both undefined when no options are given", () => {
		const fk = fkFor("")
		expect(fk?.onDelete).toBeUndefined()
		expect(fk?.onUpdate).toBeUndefined()
	})
})
