/**
 * comb's own `migrate diff` output on Postgres, through the real Atlas and comb's own policy diff,
 * never needs an in-file approval unless it destroys data: an enum, a CHECK, indexes, row level
 * security and its policies made, changed and dropped, and ADD COLUMN all rate safe or cautious
 * against the history before them.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { generateIncrementalMigration } from "../../../src/migrate/core/migrate-diff.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"

import { withScratchDb } from "../support/pg.ts"

const TABLES = `CREATE TYPE "status" AS ENUM ('active', 'banned');
CREATE TABLE "member" ("id" text PRIMARY KEY, "org" text NOT NULL, "status" "status" NOT NULL DEFAULT 'active', "seats" integer NOT NULL DEFAULT 1 CHECK ("seats" > 0)COLUMN);
CREATE INDEX "member_org_idx" ON "member" ("org");
ALTER TABLE "member" ENABLE ROW LEVEL SECURITY;
`
const READABLE = `CREATE POLICY "readable" ON "member" AS PERMISSIVE FOR SELECT TO public USING (true);\n`

const STEPS: Array<{ name: string; target: string }> = [
	{ name: "init", target: TABLES.replace("COLUMN", "") + READABLE },
	{
		name: "add_column_and_policy",
		target: TABLES.replace("COLUMN", ', "bio" text') + READABLE.replace("USING (true)", "USING (org <> '')"),
	},
	{ name: "drop_policy", target: TABLES.replace("COLUMN", ', "bio" text') },
]

describe("comb's own diff output on Postgres", () => {
	describe("with Atlas v1.3.0", () => {
		it("rates safe or cautious, never unsafe, against the history before it", async () => {
			const dir = mkdtempSync(join(tmpdir(), "comb-pg-own-"))
			try {
				await withScratchDb(async (dev) => {
					const ratings: string[] = []
					const texts: string[] = []
					for (const step of STEPS) {
						const before = extractSchema(texts.join("\n"), undefined, "postgres")
						const written = generateIncrementalMigration({
							dialect: "postgres",
							migrationName: step.name,
							migrationsDir: dir,
							target: { devUrl: dev, lockTimeout: "5s", schema: "public", url: "" },
							targetSchema: step.target,
						})
						const sql = readFileSync(written.files[0] as string, "utf8")
						texts.push(sql)
						const rated = classifyMigration(sql, { before, dialect: "postgres" })
						expect(rated.unsafeStatements, step.name).toEqual([])
						ratings.push(`${step.name}: ${rated.safety}`)
					}
					expect(texts[0]).toMatch(/CREATE POLICY "readable"/)
					expect(texts[1]).toMatch(/(?:ALTER|DROP) POLICY (?:IF EXISTS )?"readable"/)
					expect(texts[2]).toMatch(/DROP POLICY/)
					/* a policy made, changed or dropped changes which rows a role sees: a person confirms it */
					expect(ratings).toEqual(["init: cautious", "add_column_and_policy: cautious", "drop_policy: cautious"])
				})
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		}, 180_000)
	})
})

describe("own-output's steps", () => {
	it("hold a table, a policy and the column each step adds", () => {
		expect(STEPS.map(({ target }) => /CREATE POLICY/.test(target))).toEqual([true, true, false])
		expect(STEPS.map(({ target }) => /"bio"/.test(target))).toEqual([false, true, true])
	})
})
