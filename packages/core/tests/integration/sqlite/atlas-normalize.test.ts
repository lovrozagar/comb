/**
 * drizzle-kit 1.0.0-rc.4 exports a SQLite primary key without NOT NULL, which Atlas reads as a
 * nullable column. On the real drizzle-kit and the real Atlas: a history that says NOT NULL diffs
 * as synced against the normalized export, and a history comb 0.7 wrote from the raw export
 * (`text NULL`) rebuilds its key tables once, guarded where other tables reference them.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { exportDrizzleSchema } from "../../../src/migrate/core/atlas.ts"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { generateIncrementalMigration } from "../../../src/migrate/core/migrate-diff.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"

const core = join(import.meta.dirname, "../../..")

/* every primary key form drizzle-kit writes: text, numeric, composite, and integer ones that are rowid aliases */
const SCHEMA = `import { integer, numeric, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
export const account = sqliteTable("account", { id: text("id").primaryKey(), email: text("email").notNull() })
export const price = sqliteTable("price", { amount: numeric("amount").primaryKey() })
export const pair = sqliteTable("pair", { x: text("x"), y: integer("y") }, (t) => [primaryKey({ columns: [t.x, t.y] })])
export const counter = sqliteTable("counter", { id: integer("id").primaryKey() })
export const serial = sqliteTable("serial", { id: integer("id").primaryKey({ autoIncrement: true }) })
export const post = sqliteTable("post", { id: integer("id").primaryKey(), author: text("author").references(() => account.id, { onDelete: "cascade" }) })
`

/* the history Atlas writes for that schema with every key column NOT NULL */
const SYNCED = `CREATE TABLE \`account\` (\`id\` text NOT NULL, \`email\` text NOT NULL, PRIMARY KEY (\`id\`));
CREATE TABLE \`price\` (\`amount\` numeric NOT NULL, PRIMARY KEY (\`amount\`));
CREATE TABLE \`pair\` (\`x\` text NOT NULL, \`y\` integer NOT NULL, PRIMARY KEY (\`x\`, \`y\`));
CREATE TABLE \`counter\` (\`id\` integer NULL, PRIMARY KEY (\`id\`));
CREATE TABLE \`serial\` (\`id\` integer NULL PRIMARY KEY AUTOINCREMENT);
CREATE TABLE \`post\` (\`id\` integer NULL, \`author\` text NULL, PRIMARY KEY (\`id\`), CONSTRAINT \`0\` FOREIGN KEY (\`author\`) REFERENCES \`account\` (\`id\`) ON UPDATE NO ACTION ON DELETE CASCADE);
`

let work = ""
let dir = ""
beforeEach(() => {
	/* inside the package, so drizzle-orm and drizzle-kit resolve from its dependencies */
	work = join(core, `.tmp-sqlite-export-${process.pid}`)
	mkdirSync(work, { recursive: true })
	writeFileSync(join(work, "schema.ts"), SCHEMA)
	writeFileSync(
		join(work, "drizzle.config.ts"),
		`export default { dialect: "sqlite", schema: "${join(work, "schema.ts")}" }\n`,
	)
	dir = mkdtempSync(join(tmpdir(), "comb-sqlite-normalize-"))
})
afterEach(() => {
	rmSync(work, { force: true, recursive: true })
	rmSync(dir, { force: true, recursive: true })
})

const exported = () =>
	exportDrizzleSchema({ configPath: join(work, "drizzle.config.ts"), cwd: core, dialect: "sqlite" })
const diff = (name: string) =>
	generateIncrementalMigration({ dialect: "sqlite", migrationName: name, migrationsDir: dir, targetSchema: exported() })

describe("the normalized drizzle-kit SQLite export on Atlas v1.3.0", () => {
	it("diffs as synced against a history whose key columns are NOT NULL", () => {
		writeFileSync(join(dir, "20260101000000_init.sql"), SYNCED)
		generateIncrementalMigration({ dialect: "sqlite", migrationName: "hash", migrationsDir: dir, targetSchema: SYNCED })
		expect(diff("again")).toEqual({ files: [], synced: true })
	}, 60_000)

	it("rebuilds the text keys of a history comb 0.7 wrote from the raw export once, guarding a referenced one", () => {
		const raw = SYNCED.replace("`id` text NOT NULL, `email`", "`id` text NULL, `email`")
		writeFileSync(join(dir, "20260101000000_init.sql"), raw)
		generateIncrementalMigration({ dialect: "sqlite", migrationName: "hash", migrationsDir: dir, targetSchema: raw })
		const [file] = diff("not_null").files
		const sql = readFileSync(file as string, "utf8")
		expect(sql).toContain("CREATE TABLE `_comb_keep_post` AS SELECT")
		expect(classifyMigration(sql, { before: extractSchema(raw), dialect: "sqlite" }).safety).toBe("cautious")
		expect(diff("after").synced).toBe(true)
	}, 60_000)
})
