import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { validateTables } from "./validate.ts"

let tmpDir: string

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-validate-"))
})

afterEach(() => {
	fs.rmSync(tmpDir, { force: true, recursive: true })
})

/** Writes `content` as the tables file in the temp dir and returns its path. */
function writeTables(content: string): string {
	const fp = path.join(tmpDir, "db.test.tables.ts")
	fs.writeFileSync(fp, content)
	return fp
}

const STRUCTURE_PRELUDE = `
import { sqliteTable as createTable, text, uniqueIndex, check } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
const c = { id: () => text("id").primaryKey(), text: (n: string) => text(n), ref: (n: string) => text(n) }
`

/** Validates `body` under the structural-check prelude. */
function validateStructure(body: string) {
	return validateTables(writeTables(STRUCTURE_PRELUDE + body))
}

const MACHINE_PRELUDE = `
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	enum: (n: string, _v: readonly string[], _s?: object) => text(n),
}
`

/** Validates `body` under the state-machine prelude. */
function validateMachine(body: string) {
	return validateTables(writeTables(MACHINE_PRELUDE + body))
}

describe("validateTables", () => {
	it("returns no errors for valid schema", () => {
		const fp = writeTables(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey() }
export const user = createTable("user", { id: c.id() })
`)
		const result = validateTables(fp)
		expect(result.errors).toHaveLength(0)
	})

	it("warns about missing primary key", () => {
		const fp = writeTables(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { text: (name: string) => text(name) }
export const log = createTable("log", { msg: c.text("msg") })
`)
		const result = validateTables(fp)
		expect(result.warnings.some((w) => w.includes("no primary key"))).toBe(true)
	})

	it("errors on duplicate table names", () => {
		const fp = writeTables(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey() }
export const user = createTable("user", { id: c.id() })
export const user2 = createTable("user", { id: c.id() })
`)
		const result = validateTables(fp)
		expect(result.errors.some((e) => e.includes("Duplicate SQL table name"))).toBe(true)
	})
})

describe("validateTables: foreign keys", () => {
	it("errors on FK referencing non-existent table", () => {
		const fp = writeTables(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	ref: (name: string) => text(name),
}
export const post = createTable("post", {
	id: c.id(),
	author_id: c.ref("author_id").references(() => missing_table.id),
})
`)
		const result = validateTables(fp)
		expect(result.errors.some((e) => e.includes("FK references"))).toBe(true)
	})

	it("returns clean result for multi-table schema with valid FKs", () => {
		const fp = writeTables(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	ref: (name: string) => text(name),
}
export const user = createTable("user", { id: c.id() })
export const post = createTable("post", {
	id: c.id(),
	user_id: c.ref("user_id").references(() => user.id),
})
`)
		const result = validateTables(fp)
		expect(result.errors).toHaveLength(0)
	})
})

describe("validateTables — structural checks", () => {
	it("rejects two tables sharing one SQL name", () => {
		const result = validateStructure(`
export const a = createTable("post", { id: c.id() })
export const b = createTable("post", { id: c.id() })
`)
		expect(result.errors.join("\n")).toContain("Duplicate SQL table name")
	})

	it("rejects a duplicated field within a table", () => {
		const result = validateStructure(`
export const post = createTable("post", { id: c.id(), title: c.text("title"), title: c.text("title") })
`)
		expect(result.errors.join("\n")).toContain('duplicate field "title"')
	})

	it("rejects a foreign key pointing at a table that is not defined", () => {
		const result = validateStructure(`
export const post = createTable("post", { id: c.id(), author_id: c.ref("author_id").references(() => author.id) })
`)
		expect(result.errors.join("\n")).toContain('FK references "author"')
	})

	it("accepts a foreign key whose target is defined", () => {
		const result = validateStructure(`
export const author = createTable("author", { id: c.id() })
export const post = createTable("post", { id: c.id(), author_id: c.ref("author_id").references(() => author.id) })
`)
		expect(result.errors).toEqual([])
	})
})

describe("validateTables — structural checks: warnings and skipped statements", () => {
	it("warns about a table with no primary key", () => {
		const result = validateStructure(`
export const note = createTable("note", { body: c.text("body") })
`)
		expect(result.warnings.join("\n")).toContain("no primary key detected")
	})

	it("warns about a repeated constraint name", () => {
		const result = validateStructure(`
export const post = createTable("post", { id: c.id(), a: c.text("a"), b: c.text("b") }, (t) => [
	uniqueIndex("idx_dup").on(t.a),
	uniqueIndex("idx_dup").on(t.b),
])
`)
		expect(result.warnings.join("\n")).toContain('duplicate constraint name "idx_dup"')
	})

	it("ignores variable statements that are not table definitions", () => {
		const result = validateStructure(`
export const notATable = { id: "x" }
export const alsoNot = someOtherCall("post", {})
export const post = createTable("post", { id: c.id() })
`)
		expect(result.errors).toEqual([])
	})

	it("ignores a table call with too few arguments to inspect", () => {
		const result = validateStructure(`
export const post = createTable("post")
`)
		expect(result.errors).toEqual([])
	})

	it("accepts a composite primary key declared in the options", () => {
		const result = validateStructure(`
import { primaryKey } from "drizzle-orm/sqlite-core"
export const post_tag = createTable("post_tag", { post_id: c.ref("post_id"), tag_id: c.ref("tag_id") }, (t) => [
	primaryKey({ columns: [t.post_id, t.tag_id] }),
])
`)
		expect(result.errors).toEqual([])
		expect(result.warnings.join("\n")).not.toContain("no primary key")
	})
})

describe("validateTables — state machines", () => {
	it("accepts a well-formed machine", () => {
		const result = validateMachine(`
export const delivery = createTable("delivery", {
	id: c.id(),
	status: c.enum("status", ["queued", "sending", "sent"], {
		initial: "queued",
		terminal: ["sent"],
		transitions: { queued: ["sending"], sending: ["sent"] },
	}),
})
`)
		expect(result.errors).toEqual([])
	})

	it("rejects a name that is not a declared value", () => {
		const result = validateMachine(`
export const delivery = createTable("delivery", {
	id: c.id(),
	status: c.enum("status", ["queued", "sent"], { initial: "draft", terminal: ["done"] }),
})
`)
		expect(result.errors.join("\n")).toContain('initial names "draft"')
		expect(result.errors.join("\n")).toContain('terminal names "done"')
	})

	it("rejects a terminal state that also has outgoing transitions", () => {
		const result = validateMachine(`
export const delivery = createTable("delivery", {
	id: c.id(),
	status: c.enum("status", ["queued", "sent"], {
		terminal: ["sent"],
		transitions: { sent: ["queued"] },
	}),
})
`)
		expect(result.errors.join("\n")).toContain("listed as terminal but also has outgoing transitions")
	})
})

describe("validateTables — state machines: transition maps", () => {
	it("rejects a dead state when transitions are declared in full", () => {
		const result = validateMachine(`
export const delivery = createTable("delivery", {
	id: c.id(),
	status: c.enum("status", ["queued", "sending", "sent", "orphaned"], {
		initial: "queued",
		terminal: ["sent"],
		transitions: { queued: ["sending"], sending: ["sent"], orphaned: ["sent"] },
	}),
})
`)
		expect(result.errors.join("\n")).toContain('"orphaned" is neither initial nor reachable')
	})

	it("does not reject an unnamed state when the transitions map is partial", () => {
		const result = validateMachine(`
export const delivery = createTable("delivery", {
	id: c.id(),
	status: c.enum("status", ["queued", "sending", "sent"], {
		terminal: ["sent"],
		transitions: { queued: ["sending"] },
	}),
})
`)
		expect(result.errors).toEqual([])
	})

	it("warns when a partial map names a non-terminal with no outgoing edges", () => {
		/* `review` is a non-terminal the map does not name, so this is partial
		   rather than "declared in full" — dead-state checking stays off. */
		const result = validateMachine(`
export const delivery = createTable("delivery", {
	id: c.id(),
	status: c.enum("status", ["queued", "stuck", "review", "sent"], {
		terminal: ["sent"],
		transitions: { queued: ["sent"], stuck: [] },
	}),
})
`)
		expect(result.errors).toEqual([])
		expect(result.warnings.join("\n")).toContain('"stuck" has no outgoing transitions')
	})
})

describe("validateTables — state machines: value lists and columns", () => {
	it("reads a local const value list and validates the machine against it", () => {
		const result = validateMachine(`
const STATUSES = ["queued", "sent"] as const
export const delivery = createTable("delivery", {
	id: c.id(),
	status: c.enum("status", STATUSES, { terminal: ["sent", "gone"] }),
})
`)
		expect(result.errors).toEqual(['delivery.status: terminal names "gone", which is not a declared value'])
	})

	it("warns when the value list is a reference it cannot read", () => {
		const result = validateMachine(`
import { STATUSES } from "@app/shared"
export const delivery = createTable("delivery", {
	id: c.id(),
	status: c.enum("status", STATUSES, { terminal: ["sent"] }),
})
`)
		expect(result.errors).toEqual([])
		expect(result.warnings.join("\n")).toContain("enum values are a reference")
	})

	it("warns when two columns declare a machine", () => {
		const result = validateMachine(`
export const delivery = createTable("delivery", {
	id: c.id(),
	status: c.enum("status", ["a", "b"], { terminal: ["b"] }),
	phase: c.enum("phase", ["x", "y"], { terminal: ["y"] }),
})
`)
		expect(result.errors).toEqual([])
		expect(result.warnings.join("\n")).toMatch(/2 columns declare a state machine/)
		expect(result.warnings.join("\n")).toContain("status, phase")
	})
})

describe("validateTables: names two tables may not share (F13, F14)", () => {
	const prelude = `import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: (_prefix: string) => text("id").primaryKey() }
`
	it("refuses two tables whose names make one generated type name, naming both (F13)", () => {
		const result = validateTables(
			writeTables(`${prelude}export const post_tag = createTable("post_tag", { id: c.id("pt") })
export const postTag = createTable("post_tags", { id: c.id("pts") })`),
		)
		expect(result.errors).toContain('Tables post_tag and postTag both generate the type name "PostTag"')
	})

	it("refuses two tables that share an id prefix, naming both (F14)", () => {
		const result = validateTables(
			writeTables(`${prelude}export const team = createTable("team", { id: c.id("id_x") })
export const user = createTable("user", { id: c.id("id_x") })`),
		)
		expect(result.errors).toContain(
			'Tables team and user share the id prefix "id_x"; ids of one would pass for the other',
		)
	})
})
