import { describe, expect, it } from "vitest"
import { affected, reads } from "./pg-dependents.ts"
import { separatePgObjects } from "./pg-objects.ts"

/* a view over post, a view over that view, a view over nothing, and two policies on post */
const HISTORY = separatePgObjects(`CREATE VIEW "a" AS (select "id" from "post");
CREATE VIEW "b" AS (select "id" from "a");
CREATE VIEW "c" AS (select 1 as x);
CREATE POLICY "p" ON "post" USING (team_id IN (SELECT id FROM team));
CREATE POLICY "q" ON "post" WITH CHECK (true);`).state.objects

describe("reads", () => {
	it("reads a view's query and a policy's USING or WITH CHECK, never its own table or name", () => {
		const policy = HISTORY.get("policy p on post")
		expect(policy !== undefined && reads(policy, "team")).toBe(true)
		expect(policy !== undefined && reads(policy, "post")).toBe(false)
		const view = HISTORY.get("view b")
		expect(view !== undefined && reads(view, "a")).toBe(true)
		expect(view !== undefined && reads(view, "b")).toBe(false)
	})
})

/* R1 of plan 17: "reads" is what the parse tree names as a relation, never a word in a literal, a column or an alias */
/** The view `body` defines, as comb owns it */
const view = (body: string) => separatePgObjects(`CREATE VIEW "v" AS (${body});`).state.objects.get("view v")

describe("reads, from the parse tree", () => {
	it.each([
		["a string literal", "select 'from t' as x from u"],
		["a column", "select t from u"],
		["an alias", "select t.id from u t"],
		["a function", "select t(id) from u"],
	])("does not read t that is only %s", (_, body) => {
		const object = view(body)
		expect(object !== undefined && reads(object, "t")).toBe(false)
		expect(object !== undefined && reads(object, "u")).toBe(true)
	})

	it.each([
		'select id from "public"."t"',
		"select id from public.t",
		"select id from u join t on t.id = u.id",
		"select id from u where id in (select id from t)",
		"with x as (select id from t) select id from x",
	])("reads t in %j", (body) => {
		const object = view(body)
		expect(object !== undefined && reads(object, "t")).toBe(true)
	})

	it("reads a policy's USING and WITH CHECK, and a materialized view's query, from their trees", () => {
		const { objects } =
			separatePgObjects(`CREATE POLICY "p" ON "post" USING ('team' = 'x') WITH CHECK (id IN (SELECT id FROM owner));
CREATE MATERIALIZED VIEW "m" AS SELECT 'post' AS x FROM team;`).state
		const [policy, matview] = [objects.get("policy p on post"), objects.get("materialized view m")]
		expect([policy && reads(policy, "team"), policy && reads(policy, "owner")]).toEqual([false, true])
		expect([matview && reads(matview, "post"), matview && reads(matview, "team")]).toEqual([false, true])
	})
})

describe("affected", () => {
	it("takes a view over an altered table, every view over it, and a policy that reads it", () => {
		expect([...affected(HISTORY, HISTORY, new Set(["post"]))].sort()).toEqual([
			"policy p on post",
			"policy q on post",
			"view a",
			"view b",
		])
		expect([...affected(HISTORY, HISTORY, new Set(["team"]))]).toEqual(["policy p on post"])
		expect([...affected(HISTORY, HISTORY, new Set())]).toEqual([])
	})
})
