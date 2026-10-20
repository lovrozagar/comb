import { describe, expect, it } from "vitest"
import { applySqliteMigrationTransforms, normalizeSqliteExport, sqliteDevUrl } from "./atlas-env.ts"

describe("sqliteDevUrl", () => {
	it("names an in-memory database of its own for each Atlas run, as Atlas locks per dev URL across the host", () => {
		const [first, second] = [sqliteDevUrl(), sqliteDevUrl()]
		expect(first).toMatch(/^sqlite:\/\/comb-[0-9a-f-]{36}\?mode=memory$/)
		expect(second).not.toBe(first)
	})
})

describe("applySqliteMigrationTransforms", () => {
	it("swaps atlas's foreign_keys off/on pair, comments included, for defer_foreign_keys", () => {
		const sql = [
			"-- Disable the enforcement of foreign-keys constraints",
			"PRAGMA foreign_keys = off;",
			"CREATE TABLE a (x);",
			"-- Enable back the enforcement of foreign-keys constraints",
			"PRAGMA foreign_keys = on;",
			"",
		].join("\n")
		expect(applySqliteMigrationTransforms(sql)).toBe("PRAGMA defer_foreign_keys = on;\nCREATE TABLE a (x);\n")
	})

	it("keeps the line break before a pragma that does not open the file", () => {
		expect(
			applySqliteMigrationTransforms("CREATE TABLE a (x);\nPRAGMA foreign_keys = off;\nCREATE TABLE b (y);\n"),
		).toBe("CREATE TABLE a (x);\nPRAGMA defer_foreign_keys = on;\nCREATE TABLE b (y);\n")
	})

	it("is idempotent and leaves SQL without the pragmas alone", () => {
		const once = applySqliteMigrationTransforms(
			"PRAGMA foreign_keys = off;\nCREATE TABLE a (x);\nPRAGMA foreign_keys = on;\n",
		)
		expect(applySqliteMigrationTransforms(once)).toBe(once)
		expect(applySqliteMigrationTransforms("CREATE TABLE a (x);")).toBe("CREATE TABLE a (x);")
	})
})

/* drizzle-kit 1.0.0-rc.4's real SQLite export of each primary key form */
const EXPORT = `CREATE TABLE \`a\` (
	\`id\` text PRIMARY KEY,
	\`email\` text NOT NULL
);

CREATE TABLE \`c\` (
	\`price\` numeric(10,2) PRIMARY KEY
);

CREATE TABLE \`d\` (
	\`x\` text,
	\`y\` integer,
	CONSTRAINT \`d_pk\` PRIMARY KEY(\`x\`, \`y\`)
);

CREATE TABLE \`e\` (
	\`id\` integer PRIMARY KEY
);

CREATE TABLE \`f\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT
);

CREATE TABLE \`g\` (
	\`id\` integer,
	\`n\` text,
	PRIMARY KEY(\`id\`)
);

CREATE TABLE \`k\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`at\` text PRIMARY KEY DEFAULT 'x' NOT NULL
);
`

describe("normalizeSqliteExport", () => {
	it("adds NOT NULL to every primary key column but a rowid alias, once", () => {
		expect(normalizeSqliteExport(EXPORT)).toBe(
			EXPORT.replace("`id` text PRIMARY KEY,", "`id` text NOT NULL PRIMARY KEY,")
				.replace("numeric(10,2) PRIMARY KEY", "numeric(10,2) NOT NULL PRIMARY KEY")
				.replace("`x` text,", "`x` text NOT NULL,")
				.replace("`y` integer,\n\tCONSTRAINT", "`y` integer NOT NULL,\n\tCONSTRAINT"),
		)
	})

	it("is idempotent, and leaves SQL without a primary key alone", () => {
		const once = normalizeSqliteExport(EXPORT)
		expect(normalizeSqliteExport(once)).toBe(once)
		expect(normalizeSqliteExport("CREATE TABLE `t` (\n\t`a` text\n);\n")).toBe("CREATE TABLE `t` (\n\t`a` text\n);\n")
	})
})
