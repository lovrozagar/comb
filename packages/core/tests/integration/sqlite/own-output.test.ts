/**
 * comb's own `migrate diff` output on SQLite, through the real Atlas, never needs an in-file
 * approval unless it destroys data: each shape comb's generators and Atlas's transforms write
 * (an enum CHECK, indexes, the FTS sync triggers, ADD COLUMN, a plain rebuild, a guarded rebuild of
 * a referenced table) rates safe or cautious against the history before it.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"

import { FTS, history } from "../support/rebuild-guard.ts"

/* u is referenced, so rebuilding it is Atlas's guarded rebuild; tag is referenced by nothing */
const schema = (
	more: { column?: string; strictName?: boolean; strictTag?: boolean } = {},
) => `CREATE TABLE \`u\` (\`id\` integer PRIMARY KEY AUTOINCREMENT, \`name\` text${more.strictName ? " NOT NULL DEFAULT ''" : ""}, \`status\` text NOT NULL DEFAULT 'active' CHECK (\`status\` IN ('active', 'banned'))${more.column ?? ""});
CREATE TABLE \`post\` (\`id\` integer PRIMARY KEY AUTOINCREMENT, \`author\` integer NOT NULL REFERENCES \`u\`(\`id\`) ON DELETE CASCADE, \`title\` text);
CREATE INDEX \`post_author_idx\` ON \`post\` (\`author\`);
CREATE UNIQUE INDEX \`u_name_idx\` ON \`u\` (\`name\`);
CREATE TABLE \`tag\` (\`id\` text PRIMARY KEY, \`label\` text${more.strictTag ? " NOT NULL DEFAULT ''" : ""});
`

const STEPS: Array<{ name: string; target: string }> = [
	{ name: "init", target: schema() },
	{ name: "add_column", target: schema({ column: ", `bio` text" }) },
	{ name: "plain_rebuild", target: schema({ column: ", `bio` text", strictTag: true }) },
	{ name: "guarded_rebuild", target: schema({ column: ", `bio` text", strictName: true, strictTag: true }) },
]

describe("comb's own diff output on SQLite", () => {
	describe("each file comb writes", () => {
		it("rates safe or cautious, never unsafe, against the history before it", async () => {
			const h = history(undefined, FTS)
			try {
				const ratings: string[] = []
				const written = new Map<string, string>()
				for (const step of STEPS) {
					const before = extractSchema(
						h
							.files()
							.map((file) => readFileSync(file, "utf8"))
							.join("\n"),
					)
					const sql = readFileSync(await h.diff(step.target, step.name), "utf8")
					written.set(step.name, sql)
					const rated = classifyMigration(sql, { before, dialect: "sqlite" })
					expect(rated.unsafeStatements, step.name).toEqual([])
					ratings.push(`${step.name}: ${rated.safety}`)
				}
				/* the rebuilds and the NOT NULL they make are what a person confirms */
				expect(written.get("init")).toMatch(/CREATE TRIGGER IF NOT EXISTS post_fts_ai/)
				expect(written.get("guarded_rebuild")).toMatch(/_comb_keep_/)
				expect(written.get("plain_rebuild")).not.toMatch(/_comb_keep_/)
				expect(ratings).toEqual([
					"init: safe",
					"add_column: safe",
					"plain_rebuild: cautious",
					"guarded_rebuild: cautious",
				])
			} finally {
				h.dispose()
			}
		}, 120_000)
	})
})
