import { describe, expect, it } from "vitest"
import { devPrelude, pgDelta, separatePgObjects, withDirectivesFirst, wrapAtlasFile } from "./pg-objects.ts"

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
		expect([...next.state.objects.keys()]).toEqual(["sequence counter", "role reader", "extension citext"])
		expect(next.state.objects.get("sequence counter")?.sql).toBe('CREATE SEQUENCE "public"."counter" INCREMENT BY 5')
		expect(next.plain).toEqual(['ALTER SEQUENCE "other_seq" RESTART'])
	})

	it("reads a CREATE OR REPLACE VIEW as the view's definition", () => {
		const { state } = separatePgObjects('CREATE OR REPLACE VIEW "v" AS (select 1)')
		expect(state.objects.get("view v")?.name).toBe('"v"')
	})

	it("follows a dropped table, clearing its flags and policies, and a renamed one, moving them", () => {
		const history = target().state
		separatePgObjects('ALTER TABLE "post" RENAME TO "article";', history)
		expect([...history.rls]).toEqual([["article", { enabled: true, forced: false, name: '"article"' }]])
		expect(history.objects.get("policy post_owner on article")).toMatchObject({
			on: '"article"',
			sql: 'CREATE POLICY "post_owner" ON "article" AS PERMISSIVE FOR SELECT TO "reader" USING ("post"."owner" = current_user)',
		})
		separatePgObjects('ALTER TABLE "other" RENAME TO "else";', history)
		const { plain } = separatePgObjects('DROP TABLE IF EXISTS "x", "article" CASCADE;', history)
		expect(plain).toEqual(['DROP TABLE IF EXISTS "x", "article" CASCADE'])
		expect(history.rls.size).toBe(0)
		expect([...history.objects.keys()].some((key) => key.startsWith("policy"))).toBe(false)
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
			"DO $comb$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'writer') THEN CREATE ROLE \"writer\"; END IF; END $comb$",
			'ALTER SEQUENCE "public"."counter" INCREMENT BY 3 START WITH 10',
			'CREATE SEQUENCE "fresh" START WITH 1',
			'DROP POLICY IF EXISTS "post_owner" ON "post"',
			'DROP MATERIALIZED VIEW IF EXISTS "titles"',
		])
		expect(after).toEqual(['ALTER TABLE "post" DISABLE ROW LEVEL SECURITY'])
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

describe("withDirectivesFirst", () => {
	it("puts the directive lines first with one blank line after them, which Atlas needs to honor them", () => {
		expect(withDirectivesFirst("-- atlas:txmode none\n", "CREATE INDEX CONCURRENTLY i ON t (a);\n")).toBe(
			"-- atlas:txmode none\n\nCREATE INDEX CONCURRENTLY i ON t (a);\n",
		)
		expect(withDirectivesFirst("-- atlas:txmode none\n\n\n", "\n\nSELECT 1;\n")).toBe(
			"-- atlas:txmode none\n\nSELECT 1;\n",
		)
		expect(withDirectivesFirst("", "SELECT 1;\n")).toBe("SELECT 1;\n")
	})

	it("gives a rewritten file whose directive had no blank line after it the blank line", () => {
		const file = '-- atlas:txmode none\nCREATE INDEX CONCURRENTLY "i" ON "post" ("x");\n'
		expect(wrapAtlasFile(file, { after: [], before: ["SELECT 1"] })).toBe(
			'-- atlas:txmode none\n\nSELECT 1;\n\nCREATE INDEX CONCURRENTLY "i" ON "post" ("x");\n',
		)
	})
})

describe("devPrelude", () => {
	it("creates each extension, then each sequence, the states hold, once and only where missing", () => {
		const history = separatePgObjects('CREATE EXTENSION citext;\nCREATE SEQUENCE "public"."n" START WITH 5;').state
		const next = separatePgObjects('CREATE SEQUENCE "public"."n" START WITH 9;\nCREATE SEQUENCE "m";').state
		expect(devPrelude(history, next)).toBe(
			'DO $comb$ BEGIN CREATE EXTENSION IF NOT EXISTS citext; CREATE SEQUENCE IF NOT EXISTS "public"."n"; CREATE SEQUENCE IF NOT EXISTS "m"; END $comb$;\n',
		)
		expect(devPrelude(separatePgObjects('CREATE VIEW "v" AS (select 1)').state)).toBe("")
	})
})

describe("roles and policies over other tables", () => {
	it("reads comb's guarded CREATE ROLE back as the role it creates", () => {
		const guarded = pgDelta({ atlasSql: "", from: target().state, to: separatePgObjects('CREATE ROLE "w" WITH LOGIN') })
			.before[0] as string
		const { objects, state } = separatePgObjects(`${guarded};`)
		expect(objects.map((o) => o.sql)).toEqual(['CREATE ROLE "w" WITH LOGIN'])
		expect(state.objects.get("role w")?.sql).toBe('CREATE ROLE "w" WITH LOGIN')
	})

	it("drops a policy whose USING reads a table Atlas alters, and not one that reads none", () => {
		const team =
			'CREATE POLICY "p" ON "post" USING (team_id IN (SELECT id FROM team));\nCREATE POLICY "q" ON "post" FOR INSERT TO public;'
		const history = separatePgObjects(team).state
		const delta = pgDelta({
			atlasSql: 'ALTER TABLE "team" ALTER COLUMN "id" TYPE bigint;',
			from: history,
			to: separatePgObjects(team),
		})
		expect(delta.before).toEqual(['DROP POLICY IF EXISTS "p" ON "post"'])
	})
})
