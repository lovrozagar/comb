import { describe, expect, it } from "vitest"
import { syncTriggerOf } from "./fts-sync.ts"

const FTS = new Set(["post_fts"])
const trigger = (body: string) => `CREATE TRIGGER post_ai AFTER INSERT ON post BEGIN ${body} END`

describe("syncTriggerOf: the one FTS sync trigger rule (M43)", () => {
	it("names a trigger that writes only a row's values, or the 'delete' command, into an FTS table of the set", () => {
		expect(
			syncTriggerOf(trigger("INSERT INTO post_fts(rowid, title) VALUES (new.rowid, new.title);"), FTS, "sqlite"),
		).toBe("post_ai")
		expect(
			syncTriggerOf(
				trigger(
					"INSERT INTO post_fts(post_fts, rowid, title) VALUES ('delete', old.rowid, old.title); INSERT INTO post_fts(rowid, title) VALUES (new.rowid, new.title);",
				),
				FTS,
				"sqlite",
			),
		).toBe("post_ai")
	})

	it.each([
		["another FTS5 command", "INSERT INTO post_fts(post_fts) VALUES ('delete-all');"],
		[
			"a command beside a sync write",
			"INSERT INTO post_fts(post_fts) VALUES ('delete-all'); INSERT INTO post_fts(rowid, title) VALUES (new.rowid, new.title);",
		],
		[
			"a literal other than 'delete'",
			"INSERT INTO post_fts(post_fts, rowid, title) VALUES ('x', new.rowid, new.title);",
		],
		["a conflict clause", "INSERT OR REPLACE INTO post_fts(rowid, title) VALUES (new.rowid, new.title);"],
		["a SELECT", "INSERT INTO post_fts(rowid, title) SELECT id, title FROM post;"],
		["a table outside the set", "INSERT INTO other_fts(rowid, title) VALUES (new.rowid, new.title);"],
		/* FTS5 reads what lands in the table's own column, or in rank, as a command: only 'delete' may */
		["a row value in the command column", "INSERT INTO post_fts(post_fts) VALUES (new.title);"],
		[
			"a row value in the command column beside others",
			"INSERT INTO post_fts(post_fts, rowid, title) VALUES (new.title, old.rowid, old.title);",
		],
		["a row value in rank", "INSERT INTO post_fts(post_fts, rank) VALUES ('delete', new.title);"],
		[
			"'delete' in a column that is no command column",
			"INSERT INTO post_fts(rowid, title) VALUES ('delete', new.title);",
		],
		["fewer values than columns", "INSERT INTO post_fts(rowid, title) VALUES (new.rowid);"],
		["more values than columns", "INSERT INTO post_fts(rowid) VALUES (new.rowid, new.title);"],
	])("names no trigger for %s", (_, body) => {
		expect(syncTriggerOf(trigger(body), FTS, "sqlite")).toBeUndefined()
	})

	it("names nothing for a statement that makes no trigger", () => {
		expect(syncTriggerOf("CREATE TABLE post (id INTEGER PRIMARY KEY)", FTS, "sqlite")).toBeUndefined()
	})
})
