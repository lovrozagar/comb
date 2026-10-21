import { describe, expect, it } from "vitest"
import { alterTableFindings } from "./classify-alter.ts"
import { classifyMigration } from "./classify.ts"

const pg = { dialect: "postgres", rebuilds: new Map<string, { temp: string }>() } as const
const levels = (code: string, ctx: Parameters<typeof alterTableFindings>[1] = pg) =>
	alterTableFindings(code, ctx)?.map((finding) => finding.level)

describe("alterTableFindings", () => {
	it("reads nothing but an ALTER TABLE", () => {
		expect(alterTableFindings("ALTER INDEX i RENAME TO j", pg)).toBeUndefined()
	})

	it("reads each action of the list on its own", () => {
		expect(levels("ALTER TABLE post ADD COLUMN x int, DROP COLUMN body, ALTER COLUMN t DROP NOT NULL")).toEqual([
			"unsafe",
		])
		expect(levels("ALTER TABLE post ALTER COLUMN a TYPE bigint")).toEqual(["unsafe", "lock"])
		expect(levels("ALTER TABLE post ADD COLUMN a uuid DEFAULT gen_random_uuid()")).toEqual(["lock"])
	})

	it("names a dropped column with its table as written", () => {
		const [finding] = alterTableFindings('ALTER TABLE ONLY "public"."post" DROP COLUMN IF EXISTS "body"', pg) ?? []
		expect(finding?.drops).toEqual(["DROP COLUMN public.post.body"])
	})

	it("warns of no lock on SQLite", () => {
		const lite = { dialect: "sqlite", rebuilds: new Map<string, { temp: string }>() } as const
		expect(levels("ALTER TABLE post ALTER COLUMN a TYPE bigint", lite)).toEqual(["unsafe"])
		expect(levels("ALTER TABLE post ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES b (id)", lite)).toEqual([])
		expect(levels("ALTER TABLE post ADD COLUMN a uuid DEFAULT gen_random_uuid()", lite)).toEqual([])
	})

	it("lets the rename that ends a SQLite rebuild pass, and no other rename", () => {
		const lite = { dialect: "sqlite", rebuilds: new Map([["post", { temp: "new_post" }]]) } as const
		expect(levels("ALTER TABLE `new_post` RENAME TO `post`", lite)).toEqual([])
		expect(levels("ALTER TABLE `other` RENAME TO `post`", lite)).toEqual(["unsafe"])
		expect(levels("ALTER TABLE `new_post` RENAME TO `gone`", lite)).toEqual(["unsafe"])
	})

	it("calls an unknown action safe, and a new owner cautious, as an owner bypasses row level security", () => {
		expect(levels("ALTER TABLE post SET (fillfactor = 70)")).toEqual([])
		expect(levels("ALTER TABLE post OWNER TO r")).toEqual(["cautious"])
	})
})

describe("classifyMigration on row level security (M15)", () => {
	it.each([
		"ALTER TABLE post ENABLE ROW LEVEL SECURITY",
		"ALTER TABLE post FORCE ROW LEVEL SECURITY",
		"ALTER TABLE post NO FORCE ROW LEVEL SECURITY",
		"ALTER TABLE post DISABLE ROW LEVEL SECURITY",
		"CREATE POLICY p ON post AS RESTRICTIVE USING (false)",
	])("rates %j cautious: what the deployed code reads changes", (sql) => {
		expect(classifyMigration(sql, { dialect: "postgres" }).safety).toBe("cautious")
	})

	it("leaves a permissive policy safe", () => {
		expect(classifyMigration("CREATE POLICY p ON post USING (true)", { dialect: "postgres" }).safety).toBe("safe")
	})
})
