import { beforeAll, describe, expect, it } from "vitest"
import { loadPostgresParser } from "./pg-parser.ts"
import { emptyPgObjects, pgDelta, separatePgObjects } from "./pg-objects.ts"
import { atlasTables } from "./pg-tables.ts"

beforeAll(loadPostgresParser)

/* a secured table with a policy, as drizzle-kit 1.0.0-rc.4 exports it */
const from = separatePgObjects(`CREATE TABLE "post" ("id" integer);
ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "post_owner" ON "post" AS PERMISSIVE FOR SELECT TO public USING (true);`).state

/** The row level security statements of the delta from `from` to `next` around `atlasSql` */
const rls = (atlasSql: string, next: ReturnType<typeof separatePgObjects>) =>
	pgDelta({ atlasSql, from, to: next }).after.filter((stmt) => stmt.endsWith("ROW LEVEL SECURITY"))

describe("atlasTables", () => {
	it("reads the tables Atlas's statements alter, create and drop", () => {
		expect(
			atlasTables('CREATE TABLE "a" ("id" int);\nALTER TABLE ONLY "b" ADD COLUMN "x" int;\nDROP TABLE "c", "d";'),
		).toEqual({
			altered: new Set(["b", "c", "d"]),
			created: new Set(["a"]),
			dropped: new Set(["c", "d"]),
		})
	})
})

describe("row level security", () => {
	it("takes each change of row level security out and keeps the table's flags", () => {
		const { plain, state } = separatePgObjects(
			`CREATE TABLE "post" ("id" integer);
ALTER TABLE IF EXISTS ONLY "public"."post" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "post" FORCE ROW LEVEL SECURITY;
ALTER TABLE "team" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "team" DISABLE ROW LEVEL SECURITY;`,
		)
		expect(plain).toEqual(['CREATE TABLE "post" ("id" integer)'])
		expect([...state.rls]).toEqual([
			["post", { enabled: true, forced: true, name: '"post"' }],
			["team", { enabled: false, forced: false, name: '"team"' }],
		])
	})

	/* P14 of r19: the commands are read from the parse tree, any number per ALTER and among others */
	it("follows each row level security command an ALTER combines, and keeps one that does more for Atlas", () => {
		const { plain, state } = separatePgObjects(
			'ALTER TABLE "post" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;\nALTER TABLE "team" ADD COLUMN "x" text, ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;',
			emptyPgObjects(),
			"20260101000000_x.sql",
		)
		expect(plain).toEqual([
			'ALTER TABLE "team" ADD COLUMN "x" text, ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY',
		])
		expect([...state.rls]).toEqual([
			["post", { enabled: true, forced: true, name: '"post"' }],
			["team", { enabled: true, forced: false, name: '"team"' }],
		])
	})

	it("leaves an ALTER TABLE with no row level security command, or a table's other words for it, to Atlas", () => {
		const sql = 'ALTER TABLE "post" ADD COLUMN "row level security" text;\nALTER TABLE "post" RENAME TO "article";'
		expect(separatePgObjects(sql).plain).toEqual([
			'ALTER TABLE "post" ADD COLUMN "row level security" text',
			'ALTER TABLE "post" RENAME TO "article"',
		])
	})

	it("secures a table Atlas creates as the target says, a rename's included, and writes nothing for one it drops", () => {
		const secured = separatePgObjects(
			'ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "article" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "article" FORCE ROW LEVEL SECURITY;',
		)
		expect(rls('CREATE TABLE "article" ("id" integer);\nDROP TABLE "post";', secured)).toEqual([
			'ALTER TABLE "article" ENABLE ROW LEVEL SECURITY',
			'ALTER TABLE "article" FORCE ROW LEVEL SECURITY',
		])
		expect(rls('DROP TABLE "post";', separatePgObjects(""))).toEqual([])
		const plain = separatePgObjects('CREATE TABLE "team" ("id" integer);')
		const secureTeam = separatePgObjects('ALTER TABLE "team" ENABLE ROW LEVEL SECURITY;')
		expect(pgDelta({ atlasSql: "", from: plain.state, to: secureTeam }).after).toEqual([
			'ALTER TABLE "team" ENABLE ROW LEVEL SECURITY',
		])
	})
})
