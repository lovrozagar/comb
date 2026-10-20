import { describe, expect, it } from "vitest"
import { emptyPgObjects, pgDelta, separatePgObjects } from "./pg-objects.ts"
import { atlasTables } from "./pg-tables.ts"

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

	it("refuses a change of row level security among other actions, naming the file", () => {
		expect(() =>
			separatePgObjects(
				'ALTER TABLE "post" ADD COLUMN "x" text, ENABLE ROW LEVEL SECURITY;',
				emptyPgObjects(),
				"20260101000000_x.sql",
			),
		).toThrow(
			'20260101000000_x.sql: change row level security in an ALTER TABLE of its own, as comb writes that state itself: ALTER TABLE "post" ADD COLUMN "x" text, ENABLE ROW LEVEL SECURITY',
		)
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
