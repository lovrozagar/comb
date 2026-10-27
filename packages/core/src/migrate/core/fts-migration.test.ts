import { describe, expect, it } from "vitest"
import { asSql, type FtsState, ftsDelta, separate } from "./fts-migration.ts"

const TABLE = "CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(name, content='items', content_rowid='rowid')"
const TRIGGER =
	"CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN INSERT INTO items_fts(rowid, name) VALUES (new.rowid, new.name); END"
const NOTES = "CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes')"
const NOTES_TRIGGER =
	"CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body); END"

/** The FTS state of `sql`, run on its own */
const stateOf = (sql: string) => separate(sql, new Set()).state

describe("separate", () => {
	it("takes FTS tables, the triggers writing into them, their drops and rebuilds out of the plain SQL", () => {
		const sql = asSql([
			"CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)",
			TABLE,
			TRIGGER,
			"CREATE TRIGGER audit AFTER INSERT ON items BEGIN INSERT INTO log(v) VALUES (new.name); END",
			"INSERT INTO items_fts(items_fts) VALUES ('rebuild')",
			"INSERT INTO log(v) VALUES ('x')",
			"DROP TRIGGER items_fts_ai",
			"DROP TABLE old_items",
		])
		const { fts, plain, state } = separate(sql, new Set())
		expect(plain.map((statement) => statement.slice(0, 20))).toEqual([
			"CREATE TABLE items (",
			"CREATE TRIGGER audit",
			"INSERT INTO log(v) V",
			"DROP TABLE old_items",
		])
		expect(fts).toHaveLength(4)
		expect([...state.keys()]).toEqual(["items_fts"])
	})

	it("continues from the state and groups an earlier file left", () => {
		const groups = new Set<string>()
		const first = separate(asSql([TABLE, TRIGGER]), groups)
		const second = separate("DROP TABLE IF EXISTS items_fts;", groups, first.state)
		expect(second.plain).toEqual([])
		expect([...second.state.keys()]).toEqual(["items_fts_ai"])
	})
})

describe("asSql", () => {
	it("joins statements into a file, and writes nothing for none", () => {
		expect(asSql(["SELECT 1", "SELECT 2"])).toBe("SELECT 1;\n\nSELECT 2;\n")
		expect(asSql([])).toBe("")
	})
})

/** The delta from the FTS of `from` to the FTS of `to`, around a plain diff */
function delta(from: string, to: string, plainDiff = ""): string {
	const target = separate(to, new Set())
	return ftsDelta({ from: stateOf(from), plainDiff, to: target.state, toStatements: target.fts })
}

describe("ftsDelta", () => {
	const both = asSql([TABLE, TRIGGER, NOTES, NOTES_TRIGGER])

	it("is empty when no group changed and no content table was rewritten", () => {
		expect(delta(both, both, "ALTER TABLE other ADD COLUMN x INTEGER;")).toBe("")
	})

	it("reads quoted DDL as the same group, so quoting a history's bare names rewrites nothing (D7)", () => {
		const quoted = asSql([
			`CREATE VIRTUAL TABLE IF NOT EXISTS "items_fts" USING fts5("name", content='items', content_rowid='rowid')`,
			`CREATE TRIGGER IF NOT EXISTS "items_fts_ai" AFTER INSERT ON "items" BEGIN INSERT INTO "items_fts"(rowid, "name") VALUES (new.rowid, new."name"); END`,
		])
		expect(separate(quoted, new Set()).plain).toEqual([])
		expect(delta(asSql([TABLE, TRIGGER]), quoted)).toBe("")
		expect(delta(asSql([TABLE, TRIGGER]), quoted, "DROP TABLE items;")).toContain(
			`INSERT INTO "items_fts"("items_fts") VALUES ('rebuild')`,
		)
	})

	it("rewrites only the group that changed: triggers dropped before the table, then created and rebuilt", () => {
		const changed = both.replace("fts5(body, content='notes')", "fts5(body, title, content='notes')")
		expect(delta(both, changed)).toBe(
			asSql([
				'DROP TRIGGER IF EXISTS "notes_fts_ai"',
				'DROP TABLE IF EXISTS "notes_fts"',
				"CREATE VIRTUAL TABLE notes_fts USING fts5(body, title, content='notes')",
				NOTES_TRIGGER,
				`INSERT INTO "notes_fts"("notes_fts") VALUES ('rebuild')`,
			]),
		)
	})

	/* U32: the generator's new tokenizer is a changed definition, so the next diff writes the index again */
	it("rewrites and rebuilds a group whose tokenizer changed, as a history under the old default has", () => {
		const old =
			"CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes', tokenize='unicode61 remove_diacritics 2')"
		const current = old.replace("remove_diacritics 2'", "remove_diacritics 2 categories ''L* N* Co M*'''")
		const out = delta(asSql([TABLE, TRIGGER, old, NOTES_TRIGGER]), asSql([TABLE, TRIGGER, current, NOTES_TRIGGER]))
		expect(out).toContain('DROP TABLE IF EXISTS "notes_fts"')
		expect(out).toContain("categories ''L* N* Co M*''")
		expect(out).toContain(`INSERT INTO "notes_fts"("notes_fts") VALUES ('rebuild')`)
	})

	it("adds a new group, and only drops a removed one", () => {
		expect(delta(asSql([TABLE, TRIGGER]), both)).toBe(
			asSql([NOTES, NOTES_TRIGGER, `INSERT INTO "notes_fts"("notes_fts") VALUES ('rebuild')`]),
		)
		expect(delta(both, asSql([TABLE, TRIGGER]))).toBe(
			asSql(['DROP TRIGGER IF EXISTS "notes_fts_ai"', 'DROP TABLE IF EXISTS "notes_fts"']),
		)
	})
})

describe("ftsDelta — rewrites, ordering and what the target leaves", () => {
	const both = asSql([TABLE, TRIGGER, NOTES, NOTES_TRIGGER])

	it.each([
		["a DROP TABLE", "DROP TABLE `items`;"],
		["a rebuilt copy renamed onto it", "ALTER TABLE `new_items` RENAME TO `items`;"],
	])("recreates a group whose content table the diff rewrites through %s", (_label, plainDiff) => {
		const rewritten = delta(both, both, plainDiff)
		expect(rewritten).toContain('DROP TRIGGER IF EXISTS "items_fts_ai"')
		expect(rewritten).toContain(`INSERT INTO "items_fts"("items_fts") VALUES ('rebuild')`)
		expect(rewritten).not.toContain("notes_fts")
	})

	it("orders several triggers of one group before its table", () => {
		const two = asSql([TABLE, TRIGGER, TRIGGER.replaceAll("_ai", "_ad").replace("AFTER INSERT", "AFTER DELETE")])
		const drops = delta(two, "")
			.split("\n")
			.filter((line) => line.startsWith("DROP"))
		expect(drops).toEqual([
			'DROP TRIGGER IF EXISTS "items_fts_ai";',
			'DROP TRIGGER IF EXISTS "items_fts_ad";',
			'DROP TABLE IF EXISTS "items_fts";',
		])
	})

	it("treats an FTS table without a content table as its own group, never rewritten by a diff", () => {
		const bare = "CREATE VIRTUAL TABLE tags_fts USING fts5(tag)"
		expect(delta(bare, bare, "DROP TABLE `tags`;")).toBe("")
	})

	it("creates only what the target leaves standing: not a rebuild or an object it drops again", () => {
		const target = asSql([
			NOTES,
			NOTES_TRIGGER,
			"INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')",
			"DROP TRIGGER notes_fts_ai",
		])
		expect(delta("", target)).toBe(asSql([NOTES, `INSERT INTO "notes_fts"("notes_fts") VALUES ('rebuild')`]))
	})

	it("reads a state passed in directly", () => {
		const from: FtsState = new Map([["items_fts", { group: "items_fts", kind: "table", sql: "x" }]])
		expect(ftsDelta({ from, plainDiff: "", to: new Map(), toStatements: [] })).toBe(
			asSql(['DROP TABLE IF EXISTS "items_fts"']),
		)
	})
})
