import { describe, expect, it } from "vitest"
import { alterTableFindings } from "./classify-alter.ts"
import { classifyMigration } from "./classify.ts"

const ctx = { rebuilds: new Map<string, Array<{ temp: string }>>() }
const levels = (code: string, at: Parameters<typeof alterTableFindings>[1] = ctx) =>
	alterTableFindings(code, at)?.map((finding) => finding.level)

/* SQLite's ALTER TABLE, read from its text; Postgres's is pg-ddl.ts's, from its parse tree (M70) */
describe("alterTableFindings", () => {
	it("reads nothing but an ALTER TABLE", () => {
		expect(alterTableFindings("ALTER INDEX i RENAME TO j", ctx)).toBeUndefined()
	})

	it("reads each action of the list on its own, and warns of no lock", () => {
		expect(levels("ALTER TABLE post ADD COLUMN x int, DROP COLUMN body, ALTER COLUMN t DROP NOT NULL")).toEqual([
			"unsafe",
		])
		expect(levels("ALTER TABLE post ALTER COLUMN a TYPE bigint")).toEqual(["unsafe"])
		expect(levels("ALTER TABLE post ADD COLUMN a int NOT NULL")).toEqual(["unsafe"])
		expect(levels("ALTER TABLE post ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES b (id)")).toEqual([])
		expect(levels("ALTER TABLE post ADD COLUMN a text DEFAULT (random())")).toEqual([])
		expect(levels("ALTER TABLE post ALTER COLUMN a DROP DEFAULT")).toEqual(["cautious"])
	})

	it("names a dropped column with its table as written", () => {
		const [finding] = alterTableFindings('ALTER TABLE ONLY "main"."post" DROP COLUMN IF EXISTS "body"', ctx) ?? []
		expect(finding?.drops).toEqual(["DROP COLUMN main.post.body"])
	})

	it("lets the rename that ends a SQLite rebuild pass, and no other rename", () => {
		const rebuilding = { rebuilds: new Map([["post", [{ temp: "new_post" }]]]) }
		expect(levels("ALTER TABLE `new_post` RENAME TO `post`", rebuilding)).toEqual([])
		expect(levels("ALTER TABLE `other` RENAME TO `post`", rebuilding)).toEqual(["unsafe"])
		expect(levels("ALTER TABLE `new_post` RENAME TO `gone`", rebuilding)).toEqual(["unsafe"])
	})

	it("calls a known action safe, a new owner cautious, and an unknown one unsafe", () => {
		expect(levels("ALTER TABLE post SET (fillfactor = 70)")).toEqual([])
		expect(levels("ALTER TABLE post OWNER TO r")).toEqual(["cautious"])
		expect(levels("ALTER TABLE post ENABLE TRIGGER t")).toEqual(["unsafe"])
		expect(levels("ALTER TABLE post RENAME COLUMN a TO b")).toEqual(["unsafe"])
	})
})

describe("classifyMigration on row level security (M15)", () => {
	it.each([
		"ALTER TABLE post ENABLE ROW LEVEL SECURITY",
		"ALTER TABLE post FORCE ROW LEVEL SECURITY",
		"ALTER TABLE post NO FORCE ROW LEVEL SECURITY",
		"ALTER TABLE post DISABLE ROW LEVEL SECURITY",
	])("rates %j cautious: what the deployed code reads changes", (sql) => {
		expect(classifyMigration(sql, { dialect: "postgres" }).safety).toBe("cautious")
	})

	/* a policy decides which rows the deployed code reads, and destroys none: comb does not read its predicate (M16) */
	it.each(["CREATE POLICY p ON post USING (true)", "CREATE POLICY p ON post AS RESTRICTIVE USING (false)"])(
		"rates %j cautious: what the deployed code reads changes",
		(sql) => {
			expect(classifyMigration(sql, { dialect: "postgres" }).safety).toBe("cautious")
		},
	)

	it("rates an ALTER TABLE action comb does not know unsafe, and names it", () => {
		const rated = classifyMigration("ALTER TABLE post INHERIT base", { dialect: "postgres" })
		expect(rated.unsafeStatements).toEqual([
			"ALTER TABLE post INHERIT base (comb does not recognize ALTER TABLE … INHERIT; approve it in the file)",
		])
	})
})
