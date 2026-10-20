import { describe, expect, it } from "vitest"
import { pgDelta, separatePgObjects } from "./pg-objects.ts"

/* the objects comb owns in a history: a view, a materialized view, a policy, a sequence and a role */
const OWNED = `CREATE TABLE "post" ("id" integer);
CREATE VIEW "v" AS (select "id" from "post");
CREATE MATERIALIZED VIEW "mv" AS (select "id" from "post");
CREATE POLICY "own" ON "post" USING (true);
CREATE SEQUENCE "n";
CREATE ROLE "reader";`

/** The history OWNED leaves, then `sql` read on top of it */
const after = (sql: string) => {
	const history = separatePgObjects(OWNED, undefined, "1_owned.sql")
	return { history, next: separatePgObjects(sql, history.state, "2_more.sql") }
}

describe("statements about comb's objects", () => {
	it("keeps each with its object, out of what Atlas sees", () => {
		const said = [
			`COMMENT ON VIEW "v" IS 'x'`,
			'COMMENT ON POLICY "own" ON "post" IS \'mine\'',
			'GRANT SELECT ON "v", "mv" TO PUBLIC',
			'REVOKE USAGE ON SEQUENCE "n" FROM PUBLIC',
			'ALTER POLICY "own" ON "post" USING (id > 0)',
			'ALTER VIEW IF EXISTS "v" SET (security_barrier = true)',
			'CREATE UNIQUE INDEX "mv_id" ON "mv" ("id")',
			'GRANT "reader" TO CURRENT_USER',
		]
		const { history, next } = after(`${said.join(";\n")};`)
		expect(next.plain).toEqual([])
		const extras = Object.fromEntries([...history.state.objects].map(([key, object]) => [key, object.extras]))
		expect(extras).toEqual({
			"materialized view mv": ['GRANT SELECT ON "v", "mv" TO PUBLIC', 'CREATE UNIQUE INDEX "mv_id" ON "mv" ("id")'],
			"policy own on post": [
				'COMMENT ON POLICY "own" ON "post" IS \'mine\'',
				'ALTER POLICY "own" ON "post" USING (id > 0)',
			],
			"role reader": ['GRANT "reader" TO CURRENT_USER'],
			"sequence n": ['REVOKE USAGE ON SEQUENCE "n" FROM PUBLIC'],
			"view v": [
				`COMMENT ON VIEW "v" IS 'x'`,
				'GRANT SELECT ON "v", "mv" TO PUBLIC',
				'ALTER VIEW IF EXISTS "v" SET (security_barrier = true)',
			],
		})
	})
})

describe("statements about other objects, and dropped indexes", () => {
	it("leaves a statement about tables alone, and forgets a kept index once it is dropped", () => {
		const { history, next } = after(
			'COMMENT ON TABLE "post" IS \'t\';\nGRANT SELECT ON "post" TO PUBLIC;\nCREATE INDEX "mv_id" ON "mv" ("id");\nDROP INDEX "mv_id";\nDROP INDEX "post_x";',
		)
		expect(next.plain).toEqual([
			"COMMENT ON TABLE \"post\" IS 't'",
			'GRANT SELECT ON "post" TO PUBLIC',
			'DROP INDEX "post_x"',
		])
		expect(history.state.objects.get("materialized view mv")?.extras).toEqual([])
	})

	it("leaves to Atlas what names no object comb owns, and keeps other things said when an index goes", () => {
		const unowned = [
			`COMMENT ON VIEW "other" IS 'x'`,
			'ALTER POLICY "p" ON "other" USING (true)',
			'ALTER VIEW "other" SET (security_barrier = true)',
			'CREATE INDEX "post_id" ON "post" ("id")',
		]
		const { history, next } = after(
			`${unowned.join(";\n")};\nCOMMENT ON MATERIALIZED VIEW "mv" IS 'm';\nCREATE INDEX "mv_id" ON "mv" ("id");\nDROP INDEX "mv_id";`,
		)
		expect(next.plain).toEqual(unowned)
		expect(history.state.objects.get("materialized view mv")?.extras).toEqual([
			`COMMENT ON MATERIALIZED VIEW "mv" IS 'm'`,
		])
	})

	it.each([
		['ALTER VIEW "v" RENAME TO "w"', "a rename"],
		['ALTER POLICY "own" ON "post" RENAME TO "mine"', "a policy rename"],
		['GRANT SELECT ON "v", "post" TO PUBLIC', "a grant on a view and a table at once"],
		['ALTER ROLE "reader" WITH LOGIN', "a change of a role"],
		['ALTER EXTENSION "x" UPDATE', "a change of an extension comb keeps"],
	])("refuses %j (%s), naming the file", (sql) => {
		const history = separatePgObjects(`${OWNED}\nCREATE EXTENSION "x";`, undefined, "1_owned.sql")
		expect(() => separatePgObjects(sql, history.state, "2_more.sql")).toThrow(
			`2_more.sql: ${sql} changes an object comb writes itself`,
		)
	})
})

describe("pgDelta: what was said about an object", () => {
	it("says it again after the object is created again, and only what is new when it is not", () => {
		const { history } = after(`COMMENT ON VIEW "v" IS 'x'`)
		const target = separatePgObjects(`${OWNED}\nCOMMENT ON SEQUENCE "n" IS 'counter';`)
		const recreated = pgDelta({ atlasSql: 'ALTER TABLE "post" ADD COLUMN "t" text;', from: history.state, to: target })
		expect(recreated.after).toContain(`COMMENT ON VIEW "v" IS 'x'`)
		expect(recreated.after).toContain(`COMMENT ON SEQUENCE "n" IS 'counter'`)
		const shared = separatePgObjects(`${OWNED}\nGRANT SELECT ON "v", "mv" TO PUBLIC;`)
		const once = pgDelta({ atlasSql: "", from: history.state, to: shared }).after
		expect(once.filter((sql) => sql.startsWith("GRANT"))).toEqual(['GRANT SELECT ON "v", "mv" TO PUBLIC'])
		const added = separatePgObjects(`${OWNED}\nCREATE VIEW "w" AS (select 1);\nCOMMENT ON VIEW "w" IS 'new';`)
		expect(pgDelta({ atlasSql: "", from: history.state, to: added }).after).toEqual([
			'CREATE VIEW "w" AS (select 1)',
			`COMMENT ON VIEW "w" IS 'new'`,
		])
		const kept = pgDelta({ atlasSql: "", from: history.state, to: target })
		expect(kept.after).toEqual([`COMMENT ON SEQUENCE "n" IS 'counter'`])
		const changed = separatePgObjects(OWNED.replace('select "id" from "post"', 'select "id" + 1 from "post"'))
		expect(pgDelta({ atlasSql: "", from: history.state, to: changed }).after).not.toContain(
			`COMMENT ON VIEW "v" IS 'x'`,
		)
	})
})
