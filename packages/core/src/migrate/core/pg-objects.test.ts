import { describe, expect, it } from "vitest"
import { pgDelta, separatePgObjects, wrapAtlasFile } from "./pg-objects.ts"

/* drizzle-kit 1.0.0-rc.4's export of a table with a policy, a view, a materialized view, a sequence and a role */
const EXPORT = `CREATE TYPE "status" AS ENUM('draft', 'published');
CREATE SEQUENCE "public"."counter" INCREMENT BY 2 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 10 CACHE 1;
CREATE ROLE "reader";
CREATE TABLE "post" (
	"id" integer PRIMARY KEY,
	"title" text NOT NULL,
	"status" "status" DEFAULT 'draft'::"status",
	"owner" text
);

ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;
CREATE VIEW "published" AS (select "id", "title", "status", "owner" from "post" where "post"."status" = 'published');
CREATE MATERIALIZED VIEW "titles" AS (select "title" from "post");
CREATE POLICY "post_owner" ON "post" AS PERMISSIVE FOR SELECT TO "reader" USING ("post"."owner" = current_user);`

const target = (sql = EXPORT) => separatePgObjects(sql)

describe("separatePgObjects", () => {
	it("keeps what Atlas diffs and takes out every object Atlas OSS refuses", () => {
		const { objects, plain } = target()
		expect(plain.map((stmt) => stmt.split("\n")[0])).toEqual([
			`CREATE TYPE "status" AS ENUM('draft', 'published')`,
			'CREATE TABLE "post" (',
			'ALTER TABLE "post" ENABLE ROW LEVEL SECURITY',
		])
		expect(objects.map((o) => `${o.kind} ${o.key}`)).toEqual([
			"sequence counter",
			"role reader",
			"view published",
			"materialized view titles",
			"policy post_owner on post",
		])
	})

	it("follows a history: drops remove, an ALTER SEQUENCE updates, an extension and a refresh are taken out", () => {
		const history = target().state
		const next = separatePgObjects(
			`CREATE EXTENSION IF NOT EXISTS citext;
DROP VIEW IF EXISTS "published";
DROP POLICY IF EXISTS "post_owner" ON "post";
ALTER SEQUENCE "public"."counter" INCREMENT BY 5;
REFRESH MATERIALIZED VIEW "titles";
DROP MATERIALIZED VIEW "titles", "gone";
ALTER SEQUENCE "other_seq" RESTART;`,
			history,
		)
		expect([...next.state.keys()]).toEqual(["sequence counter", "role reader", "extension citext"])
		expect(next.state.get("sequence counter")?.sql).toBe('CREATE SEQUENCE "public"."counter" INCREMENT BY 5')
		expect(next.plain).toEqual(['ALTER SEQUENCE "other_seq" RESTART'])
	})

	it("reads a CREATE OR REPLACE VIEW as the view's definition", () => {
		const { state } = separatePgObjects('CREATE OR REPLACE VIEW "v" AS (select 1)')
		expect(state.get("view v")?.name).toBe('"v"')
	})
})

describe("pgDelta", () => {
	const from = target().state
	const to = target()
	const delta = (atlasSql: string, next = to) => pgDelta({ atlasSql, from, to: next })

	it("is empty when nothing changed and Atlas touches no table under a view or policy", () => {
		expect(delta('CREATE TABLE "other" ("id" integer);')).toEqual({ after: [], before: [] })
	})

	it("drops the views and policies over a table Atlas alters before its statements, and recreates them after", () => {
		const { after, before } = delta('ALTER TABLE "post" ALTER COLUMN "title" TYPE character varying(50);')
		expect(before).toEqual([
			'DROP POLICY IF EXISTS "post_owner" ON "post"',
			'DROP MATERIALIZED VIEW IF EXISTS "titles"',
			'DROP VIEW IF EXISTS "published"',
		])
		expect(after.map((stmt) => stmt.split(" AS ")[0])).toEqual([
			'CREATE VIEW "published"',
			'CREATE MATERIALIZED VIEW "titles"',
			'CREATE POLICY "post_owner" ON "post"',
		])
	})

	it("drops a view that reads a dropped view first, and recreates both in the target's order", () => {
		const chain = separatePgObjects(`CREATE VIEW "a" AS (select 1 as x);\nCREATE VIEW "b" AS (select "x" from "a");`)
		const changed = separatePgObjects(`CREATE VIEW "a" AS (select 2 as x);\nCREATE VIEW "b" AS (select "x" from "a");`)
		const result = pgDelta({ atlasSql: "", from: chain.state, to: changed })
		expect(result.before).toEqual(['DROP VIEW IF EXISTS "b"', 'DROP VIEW IF EXISTS "a"'])
		expect(result.after).toEqual(['CREATE VIEW "a" AS (select 2 as x)', 'CREATE VIEW "b" AS (select "x" from "a")'])
	})

	it("creates new objects, alters a changed sequence, drops removed ones, and never drops a role or an extension", () => {
		const next = separatePgObjects(
			`CREATE EXTENSION citext;
CREATE ROLE "writer";
CREATE SEQUENCE "public"."counter" INCREMENT BY 3 START WITH 10;
CREATE SEQUENCE "fresh" START WITH 1;
CREATE VIEW "published" AS (select "id", "title", "status", "owner" from "post" where "post"."status" = 'published');`,
		)
		const { after, before } = delta("", next)
		expect(before).toEqual([
			"CREATE EXTENSION IF NOT EXISTS citext",
			'CREATE ROLE "writer"',
			'ALTER SEQUENCE "public"."counter" INCREMENT BY 3 START WITH 10',
			'CREATE SEQUENCE "fresh" START WITH 1',
			'DROP POLICY IF EXISTS "post_owner" ON "post"',
			'DROP MATERIALIZED VIEW IF EXISTS "titles"',
		])
		expect(after).toEqual([])
	})

	it("drops a table's policies before Atlas drops the table, and does not recreate them", () => {
		const gone = separatePgObjects(EXPORT.replace(/CREATE POLICY[^\n]*/, ""))
		const { after, before } = delta('DROP TABLE "post";', gone)
		expect(before[0]).toBe('DROP POLICY IF EXISTS "post_owner" ON "post"')
		expect(after.some((stmt) => stmt.startsWith("CREATE POLICY"))).toBe(false)
	})
})

describe("wrapAtlasFile", () => {
	it("puts comb's statements around Atlas's, under Atlas's directives", () => {
		const file = '-- atlas:txmode none\n\n-- Modify "post" table\nALTER TABLE "post" ADD COLUMN "x" text;\n'
		expect(wrapAtlasFile(file, { after: ['CREATE VIEW "v" AS (select 1)'], before: ['DROP VIEW IF EXISTS "v"'] })).toBe(
			'-- atlas:txmode none\n\nDROP VIEW IF EXISTS "v";\n\n-- Modify "post" table\nALTER TABLE "post" ADD COLUMN "x" text;\n\nCREATE VIEW "v" AS (select 1);\n',
		)
	})

	it("leaves a file alone when comb adds nothing, and writes comb's part alone when Atlas wrote nothing", () => {
		expect(wrapAtlasFile("SELECT 1;\n", { after: [], before: [] })).toBe("SELECT 1;\n")
		expect(wrapAtlasFile("", { after: ["SELECT 2"], before: ["SELECT 1"] })).toBe("SELECT 1;\n\nSELECT 2;\n")
	})
})
