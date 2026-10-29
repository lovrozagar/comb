import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { type RebuildContext, rebuildFinding } from "./classify-rebuild.ts"
import { extractSchema } from "./schema.ts"

const before = extractSchema("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT);")
const rebuild = {
	columns: ["id", "a"],
	definition: "CREATE TABLE new_t (id INTEGER PRIMARY KEY, a TEXT)",
	problem: undefined,
	temp: "new_t",
}

/** What the rule reads, with the rebuild of t as given */
const context = (over: Partial<RebuildContext> = {}): RebuildContext => ({
	after: undefined,
	before,
	dialect: "sqlite",
	naming: "sqlite",
	kept: new Map(),
	drops: new Map(),
	fired: new Map(),
	rebuilds: new Map([["t", [rebuild]]]),
	renumbered: new Map(),
	txmodeNone: false,
	unguarded: new Map(),
	...over,
})

describe("rebuildFinding", () => {
	it("reads no drop it does not know as a rebuild", () => {
		expect(rebuildFinding(undefined, context())).toBeUndefined()
		expect(rebuildFinding("other", context())).toBeUndefined()
	})

	it("refuses a rebuild outside the file's transaction, of unknown columns, unguarded, or with a changed copy", () => {
		expect(rebuildFinding("t", context({ txmodeNone: true }))?.level).toBe("unsafe")
		expect(rebuildFinding("T", context({ before: undefined }))?.note).toBe(
			"rebuilds t, whose earlier columns are unknown",
		)
		expect(rebuildFinding("t", context({ unguarded: new Map([["t", ["c"]]]) }))?.note).toContain("rebuilds t unguarded")
		const changed = new Map([["t", [{ ...rebuild, problem: "its copy is changed before the rename" }]]])
		expect(rebuildFinding("t", context({ rebuilds: changed }))?.note).toBe(
			"rebuilds t: its copy is changed before the rename",
		)
	})

	it("rates a copy of every column into an equal table cautious, naming what the guard keeps and renumbers", () => {
		expect(rebuildFinding("t", context())).toEqual({ level: "cautious", note: "rebuilds t, copying every column" })
		expect(
			rebuildFinding(
				"t",
				context({ kept: new Map([["t", ["c"]]]), renumbered: new Map([["t", ["c gets new rowids"]]]) }),
			),
		).toEqual({
			level: "cautious",
			note: "rebuilds t; comb keeps the rows of c; c gets new rowids",
		})
	})

	it("rates a copy that leaves a column out, or retypes one, unsafe", () => {
		const without = new Map([["t", [{ ...rebuild, columns: ["id"] }]]])
		expect(rebuildFinding("t", context({ rebuilds: without }))).toEqual({
			drops: ["DROP COLUMN t.a"],
			level: "unsafe",
			note: "rebuilds t without a",
		})
		const retyped = new Map([
			["t", [{ ...rebuild, definition: "CREATE TABLE new_t (id INTEGER PRIMARY KEY, a INTEGER)" }]],
		])
		expect(rebuildFinding("t", context({ rebuilds: retyped }))?.note).toContain(
			"changes a's affinity from TEXT to INTEGER",
		)
		const undefinedCopy = new Map([["t", [{ ...rebuild, definition: "" }]]])
		expect(rebuildFinding("t", context({ rebuilds: undefinedCopy }))?.level).toBe("cautious")
	})
})

/** Atlas's rebuild of post, `after` following it */
const rebuildPost = (after = "") => `CREATE TABLE \`new_post\` (\`id\` integer NULL PRIMARY KEY, \`title\` text NULL);
INSERT INTO \`new_post\` (\`id\`, \`title\`) SELECT \`id\`, \`title\` FROM \`post\`;
DROP TABLE \`post\`;
ALTER TABLE \`new_post\` RENAME TO \`post\`;
${after}`

/* S2 of the 0.14.1 review: DROP TABLE takes the table's triggers with it, and a rebuild's copy writes none back */
describe("classifyMigration on a rebuild of a table with triggers", () => {
	const history = extractSchema(`CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT);
CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post', content_rowid='id');
CREATE TRIGGER post_ai AFTER INSERT ON post BEGIN INSERT INTO post_fts(rowid, title) VALUES (new.id, new.title); END;
CREATE TRIGGER post_audit AFTER UPDATE ON post BEGIN SELECT 1; END;`)

	it("is unsafe for each trigger the file does not create again, naming it", () => {
		const rated = classifyMigration(
			rebuildPost(
				"CREATE TRIGGER post_ai AFTER INSERT ON post BEGIN INSERT INTO post_fts(rowid, title) VALUES (new.id, new.title); END;",
			),
			{ before: history, dialect: "sqlite" },
		)
		expect(rated.safety).toBe("unsafe")
		expect(rated.unsafeStatements).toEqual(["DROP TABLE `post` (rebuilds post, dropping its trigger post_audit)"])
		expect(classifyMigration(rebuildPost(), { before: history, dialect: "sqlite" }).unsafeStatements).toEqual([
			"DROP TABLE `post` (rebuilds post, dropping its triggers post_ai, post_audit)",
		])
	})

	/* a trigger comb does not write, such as the audit one, is rated on its own, needing the file's approval */
	it("drops no trigger the file creates again, so its rebuild copies every column", () => {
		const again = `CREATE TRIGGER post_ai AFTER INSERT ON post BEGIN INSERT INTO post_fts(rowid, title) VALUES (new.id, new.title); END;
CREATE TRIGGER post_audit AFTER UPDATE ON post BEGIN SELECT 1; END;`
		const rated = classifyMigration(rebuildPost(again), { before: history, dialect: "sqlite" })
		expect(rated.cautiousStatements).toEqual(["DROP TABLE `post` (rebuilds post, copying every column)"])
		expect(rated.unsafeStatements).toEqual([
			"CREATE TRIGGER post_audit AFTER UPDATE ON post BEGIN SELECT 1; END (comb does not recognize CREATE TRIGGER; approve it in the file)",
		])
	})
})
