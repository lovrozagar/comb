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
