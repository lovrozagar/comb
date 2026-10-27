/**
 * S1 of the M75 review: a Postgres file is parsed once. The read keeps each statement's parse
 * tree beside the schema it leaves, so the history's facts and each statement's findings follow
 * those trees, and the file-naming check reads that read's first unreadable statement.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { classifyMigration } from "./classify.ts"
import { postgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

const HISTORY =
	'CREATE TABLE "a" ("id" int); CREATE TRIGGER "t" BEFORE INSERT ON "a" FOR EACH ROW EXECUTE FUNCTION f();'
const LATER = 'INSERT INTO "a" VALUES (1);'

afterEach(() => vi.restoreAllMocks())

/** What the parser is given while `body` runs */
function parsed(body: () => void): string[] {
	const spy = vi.spyOn(postgresParser(), "parseSync")
	body()
	return spy.mock.calls.map(([sql]) => sql)
}

describe("a Postgres file parsed once", () => {
	it("classifies against a history without parsing the history or the statement again", () => {
		const before = extractSchema(HISTORY, undefined, "postgres")
		let unsafe: string[] = []
		expect(parsed(() => (unsafe = classifyMigration(LATER, { before, dialect: "postgres" }).unsafeStatements))).toEqual(
			[LATER],
		)
		expect(unsafe.join(" ")).toContain("fires trigger t")
	})

	it("reads a history it holds no trees for from its statements, as before", () => {
		const before = { ...extractSchema(HISTORY, undefined, "postgres") }
		const calls = parsed(() =>
			expect(classifyMigration(LATER, { before, dialect: "postgres" }).unsafeStatements.join(" ")).toContain(
				"fires trigger t",
			),
		)
		expect(calls).toContain('CREATE TABLE "a" ("id" int)')
	})

	it("keeps no trees for a schema read on from one without a record, so its whole history is parsed again", () => {
		const before = extractSchema("SELECT 1;", { ...extractSchema(HISTORY, undefined, "postgres") }, "postgres")
		const calls = parsed(() =>
			expect(classifyMigration(LATER, { before, dialect: "postgres" }).unsafeStatements.join(" ")).toContain(
				"fires trigger t",
			),
		)
		expect(calls).toEqual(expect.arrayContaining(['CREATE TABLE "a" ("id" int)', "SELECT 1"]))
	})
})
