import { describe, expect, it } from "vitest"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { classifyMigration } from "./classify.ts"
import { guardRebuilds } from "./rebuild-guard.ts"
import { extractSchema } from "./schema.ts"

/* the earlier migrations: a parent, a child of it and a grandchild, an FTS trigger on the child */
const BEFORE = extractSchema(`CREATE TABLE \`u\` (\`id\` integer PRIMARY KEY, \`name\` text);
CREATE TABLE \`post\` (\`id\` integer PRIMARY KEY, \`author\` integer REFERENCES \`u\`(\`id\`) ON DELETE CASCADE, \`title\` text);
CREATE TABLE \`tag\` (\`post\` integer NOT NULL REFERENCES \`post\`(\`id\`), \`name\` text NOT NULL, PRIMARY KEY (\`post\`, \`name\`)) WITHOUT ROWID;
CREATE TRIGGER post_fts_ai AFTER INSERT ON post BEGIN SELECT 1; END;`)

/* Atlas v1.3.0's rebuild of u */
const REBUILD = `PRAGMA defer_foreign_keys = on;
CREATE TABLE \`new_u\` (\`id\` integer NOT NULL, \`name\` text NOT NULL DEFAULT '', PRIMARY KEY (\`id\`));
INSERT INTO \`new_u\` (\`id\`, \`name\`) SELECT \`id\`, IFNULL(\`name\`, '') AS \`name\` FROM \`u\`;
DROP TABLE \`u\`;
ALTER TABLE \`new_u\` RENAME TO \`u\`;
`

const FTS = new Map([["post_fts_ai", { group: "post_fts", kind: "trigger" as const, sql: "" }]])

describe("guardRebuilds", () => {
	it("saves and empties what the drop reaches, children first, and refills it after the rename, parents first", () => {
		expect(guardRebuilds(REBUILD, BEFORE, FTS)).toBe(`PRAGMA defer_foreign_keys = on;
CREATE TABLE \`new_u\` (\`id\` integer NOT NULL, \`name\` text NOT NULL DEFAULT '', PRIMARY KEY (\`id\`));
INSERT INTO \`new_u\` (\`id\`, \`name\`) SELECT \`id\`, IFNULL(\`name\`, '') AS \`name\` FROM \`u\`;
PRAGMA defer_foreign_keys = on;
CREATE TABLE \`_comb_keep_post\` AS SELECT \`id\`, \`author\`, \`title\` FROM \`post\`;
CREATE TABLE \`_comb_keep_tag\` AS SELECT \`post\`, \`name\` FROM \`tag\`;
DELETE FROM \`tag\`;
DELETE FROM \`post\`;
DROP TABLE \`u\`;
ALTER TABLE \`new_u\` RENAME TO \`u\`;
INSERT INTO \`post\` (\`id\`, \`author\`, \`title\`) SELECT \`id\`, \`author\`, \`title\` FROM \`_comb_keep_post\`;
INSERT INTO \`tag\` (\`post\`, \`name\`) SELECT \`post\`, \`name\` FROM \`_comb_keep_tag\`;
DROP TABLE \`_comb_keep_post\`;
DROP TABLE \`_comb_keep_tag\`;
`)
	})

	it("leaves a file alone without the earlier schema, without a rebuild, or with a rebuild nothing references", () => {
		expect(guardRebuilds(REBUILD, undefined)).toBe(REBUILD)
		expect(guardRebuilds("CREATE TABLE x (id integer);\n", BEFORE)).toBe("CREATE TABLE x (id integer);\n")
		const tagRebuild = REBUILD.replaceAll("new_u", "new_tag")
			.replaceAll("`u`", "`tag`")
			.replace("`id`, `name`) SELECT `id`", "`post`, `name`) SELECT `post`")
		expect(guardRebuilds(tagRebuild, BEFORE)).toBe(tagRebuild)
		/* a copy that is never dropped, and a drop that ends no copy, are no rebuild */
		const halves =
			"INSERT INTO `new_u` (`id`) SELECT `id` FROM `u`;\nDROP TABLE `post`;\nALTER TABLE `x` RENAME TO `u`;\n"
		expect(guardRebuilds(halves, BEFORE)).toBe(halves)
	})

	it("refuses a trigger that is not FTS on a table the drop reaches, naming it", () => {
		expect(() => guardRebuilds(REBUILD, BEFORE)).toThrow(
			"a rebuild of u empties and refills post, which fires its trigger post_fts_ai; drop the trigger first, or change u by hand",
		)
	})

	it("refuses a reached table whose columns the migrations do not show", () => {
		const partial = { ...BEFORE, tableInfo: new Map([...BEFORE.tableInfo].filter(([table]) => table !== "tag")) }
		expect(() => guardRebuilds(REBUILD, partial, FTS)).toThrow(
			"a rebuild of u reaches tag, whose columns the migrations do not show",
		)
		const gone = { ...BEFORE, tables: new Map([...BEFORE.tables].filter(([table]) => table !== "tag")) }
		expect(() => guardRebuilds(REBUILD, gone, FTS)).toThrow("reaches tag")
	})
})

const classify = (sql: string) => classifyMigration(sql, { before: BEFORE, dialect: "sqlite" })

describe("classifyMigration on a rebuild of a referenced table", () => {
	it("calls comb's guarded rebuild cautious, and the same rebuild unguarded unsafe, naming what it reaches", () => {
		expect(classify(guardRebuilds(REBUILD, BEFORE, FTS))).toMatchObject({
			cautiousStatements: ["DROP TABLE `u` (rebuilds u; comb keeps the rows of post, tag)"],
			safety: "cautious",
		})
		expect(classify(REBUILD).unsafeStatements).toEqual([
			"DROP TABLE `u` (rebuilds u unguarded: its drop deletes or orphans the rows of post, tag; let comb migrate diff write it)",
		])
	})

	it("still calls a guard comb 0.8 wrote cautious: a rowid alias kept apart as `_comb_rowid`", () => {
		const legacy = guardRebuilds(REBUILD, BEFORE, FTS)
			.replace("PRAGMA defer_foreign_keys = on;\nCREATE TABLE `_comb_keep_post`", "CREATE TABLE `_comb_keep_post`")
			.replace("AS SELECT `id`, `author`", "AS SELECT rowid AS `_comb_rowid`, `id`, `author`")
			.replace(
				"INSERT INTO `post` (`id`, `author`, `title`) SELECT `id`",
				"INSERT INTO `post` (rowid, `id`, `author`, `title`) SELECT `_comb_rowid`, `id`",
			)
		expect(legacy).toContain("rowid AS `_comb_rowid`")
		expect(classify(legacy)).toMatchObject({
			cautiousStatements: ["DROP TABLE `u` (rebuilds u; comb keeps the rows of post, tag)"],
			safety: "cautious",
		})
	})

	it("calls a guard edited by hand unsafe, as it no longer keeps every row", () => {
		const edited = guardRebuilds(REBUILD, BEFORE, FTS).replace(
			"DELETE FROM `tag`;",
			"DELETE FROM `tag`;\nDELETE FROM `u`;",
		)
		expect(classify(edited).safety).toBe("unsafe")
		const short = guardRebuilds(REBUILD, BEFORE, FTS).replace(/^INSERT INTO `tag`.*\n/m, "")
		expect(classify(short).safety).toBe("unsafe")
		const cut = guardRebuilds(REBUILD, BEFORE, FTS).split("ALTER TABLE `new_u` RENAME TO `u`;")[0]
		expect(classify(`${cut}ALTER TABLE \`new_u\` RENAME TO \`u\`;`).safety).toBe("unsafe")
	})
})

/** Atlas's rebuild of `table` into a copy with `columns`, copying its id */
const rebuild = (table: string, columns: string) =>
	`CREATE TABLE \`new_${table}\` (${columns});\nINSERT INTO \`new_${table}\` (\`id\`) SELECT \`id\` FROM \`${table}\`;\nDROP TABLE \`${table}\`;\nALTER TABLE \`new_${table}\` RENAME TO \`${table}\`;\n`

describe("guardRebuilds: the order it empties and refills", () => {
	/* u ← p, u ← c, and c → p ON DELETE RESTRICT: c must go before p, whatever order the keys were declared in */
	const before = extractSchema(`CREATE TABLE \`u\` (\`id\` integer PRIMARY KEY);
CREATE TABLE \`p\` (\`id\` integer PRIMARY KEY, \`u\` integer REFERENCES \`u\`(\`id\`));
CREATE TABLE \`c\` (\`id\` integer PRIMARY KEY, \`u\` integer REFERENCES \`u\`(\`id\`), \`p\` integer REFERENCES \`p\`(\`id\`) ON DELETE RESTRICT);`)

	it("empties each child before its parent, and refills each parent before its child", () => {
		const sql = guardRebuilds(
			rebuild(
				"p",
				"`id` integer NOT NULL, `u` integer NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`u`) REFERENCES `u` (`id`)",
			) + rebuild("u", "`id` integer NOT NULL, PRIMARY KEY (`id`)"),
			before,
		)
		const block = sql.slice(sql.indexOf("CREATE TABLE `new_u`"))
		expect(block.indexOf("DELETE FROM `c`")).toBeLessThan(block.indexOf("DELETE FROM `p`"))
		expect(block.indexOf("INSERT INTO `p`")).toBeLessThan(block.indexOf("INSERT INTO `c`"))
	})

	it("keeps every row on libsql with foreign keys on and no defer_foreign_keys", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			"CREATE TABLE `u` (`id` integer PRIMARY KEY); CREATE TABLE `p` (`id` integer PRIMARY KEY, `u` integer REFERENCES `u`(`id`)); CREATE TABLE `c` (`id` integer PRIMARY KEY, `u` integer REFERENCES `u`(`id`), `p` integer REFERENCES `p`(`id`) ON DELETE RESTRICT); INSERT INTO u VALUES (1); INSERT INTO p VALUES (10, 1); INSERT INTO c VALUES (100, 1, 10);",
		)
		const sql = guardRebuilds(
			rebuild(
				"p",
				"`id` integer NOT NULL, `u` integer NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`u`) REFERENCES `u` (`id`)",
			) + rebuild("u", "`id` integer NOT NULL, PRIMARY KEY (`id`)"),
			before,
		)
		await conn.client.executeMultiple(`BEGIN;\n${sql}\nCOMMIT;`)
		const rows = await conn.client.execute(
			"SELECT (SELECT count(*) FROM u) AS u, (SELECT count(*) FROM p) AS p, (SELECT count(*) FROM c) AS c",
		)
		expect({ ...rows.rows[0] }).toEqual({ c: 1, p: 1, u: 1 })
		await conn.close()
	})
})

/** `n` text columns after a text key, `c1` on */
const columns = (n: number): string => Array.from({ length: n }, (_, i) => `\`c${i + 1}\` text`).join(", ")

/** Atlas's rebuild of a text-keyed `table` with `n` more columns: `c1` gains NOT NULL */
const wideRebuild = (table: string, n: number, extra = ""): string => {
	const list = ["`id`", ...Array.from({ length: n }, (_, i) => `\`c${i + 1}\``)].join(", ")
	return `CREATE TABLE \`new_${table}\` (\`id\` text NOT NULL, ${columns(n).replace("`c1` text", "`c1` text NOT NULL DEFAULT ''")}${extra}, PRIMARY KEY (\`id\`));
INSERT INTO \`new_${table}\` (${list}) SELECT ${list} FROM \`${table}\`;
DROP TABLE \`${table}\`;
ALTER TABLE \`new_${table}\` RENAME TO \`${table}\`;
`
}

describe("guardRebuilds: rowids", () => {
	/* t, text-keyed; k99 and k100 reference it with 99 and 100 stored columns (k99's generated one not counted); w99 and w100 stand alone */
	const before = extractSchema(`CREATE TABLE \`t\` (\`id\` text PRIMARY KEY, \`c1\` text);
CREATE TABLE \`k99\` (\`id\` text PRIMARY KEY, \`t\` text REFERENCES \`t\`(\`id\`) ON DELETE CASCADE, ${columns(97)}, \`g\` integer AS (1) VIRTUAL);
CREATE TABLE \`k100\` (\`id\` text PRIMARY KEY, \`t\` text REFERENCES \`t\`(\`id\`) ON DELETE CASCADE, ${columns(98)});
CREATE TABLE \`w99\` (\`id\` text PRIMARY KEY, ${columns(98)});
CREATE TABLE \`w100\` (\`id\` text PRIMARY KEY, ${columns(99)});
CREATE TABLE \`bare\` (\`id\` text PRIMARY KEY, \`c1\` text) WITHOUT ROWID;`)
	const classifyOn = (sql: string) => classifyMigration(sql, { before, dialect: "sqlite" })

	it("carries a text-keyed table's rowid through Atlas's copy, and its children's beside at most 99 columns", () => {
		const sql = guardRebuilds(wideRebuild("t", 1), before)
		expect(sql).toContain("INSERT INTO `new_t` (rowid, `id`, `c1`) SELECT rowid, `id`, `c1` FROM `t`;")
		expect(sql).toContain("CREATE TABLE `_comb_keep_k99` AS SELECT rowid AS `_comb_rowid`, `id`, `t`, `c1`")
		expect(sql).toContain("INSERT INTO `k99` (rowid, `id`, `t`, `c1`")
		expect(sql).toContain("CREATE TABLE `_comb_keep_k100` AS SELECT `id`, `t`, `c1`")
		expect(sql).toContain("INSERT INTO `k100` (`id`, `t`, `c1`")
		expect(classifyOn(sql).cautiousStatements).toEqual([
			"DROP TABLE `t` (rebuilds t; comb keeps the rows of k99, k100; k100 gets new rowids (100 columns, no INTEGER PRIMARY KEY))",
		])
	})

	it("carries the rowid through a copy under Atlas's comments, its IFNULL and CAST untouched", () => {
		const commented = wideRebuild("t", 1)
			.replace(
				"INSERT INTO",
				'-- Copy rows from old table "t" to new temporary table "new_t"\n/* and a block */ INSERT INTO',
			)
			.replace("SELECT `id`, `c1` FROM", "SELECT CAST(`id` AS text) AS `id`, IFNULL(`c1`, '') AS `c1` FROM")
		expect(guardRebuilds(commented, before)).toContain(
			'-- Copy rows from old table "t" to new temporary table "new_t"\n/* and a block */ INSERT INTO `new_t` (rowid, `id`, `c1`) SELECT rowid, CAST(`id` AS text) AS `id`, IFNULL(`c1`, \'\') AS `c1` FROM `t`;',
		)
	})

	it("carries the rowid of a table nothing references beside 99 columns, not 100, and says which gets new rowids", () => {
		const narrow = guardRebuilds(wideRebuild("w99", 98), before)
		expect(narrow).toMatch(/^INSERT INTO `new_w99` \(rowid, `id`, `c1`, .*\) SELECT rowid, `id`, `c1`, /m)
		expect(classifyOn(narrow).cautiousStatements).toEqual(["DROP TABLE `w99` (rebuilds w99, copying every column)"])
		const wide = wideRebuild("w100", 99)
		expect(guardRebuilds(wide, before)).toBe(wide)
		expect(classifyOn(wide).cautiousStatements).toEqual([
			"DROP TABLE `w100` (rebuilds w100, copying every column; w100 gets new rowids (100 columns, no INTEGER PRIMARY KEY))",
		])
	})

	it("leaves a copy alone when the table or its copy has no rowid of its own, or the copy's key is the rowid", () => {
		const fromBare = wideRebuild("bare", 1)
		expect(guardRebuilds(fromBare, before)).toBe(fromBare)
		const intoBare = wideRebuild("w99", 98).replace("PRIMARY KEY (`id`));", "PRIMARY KEY (`id`)) WITHOUT ROWID;")
		expect(guardRebuilds(intoBare, before)).toBe(intoBare)
		const intoAlias = wideRebuild("w99", 98).replace("`id` text NOT NULL", "`id` integer NOT NULL")
		expect(guardRebuilds(intoAlias, before)).toBe(intoAlias)
		expect(guardRebuilds(wideRebuild("gone", 1), before)).toBe(wideRebuild("gone", 1))
	})
})
