import { describe, expect, it } from "vitest"
import { PG_KEYWORDS } from "../../../tests/support/pg-keywords.ts"
import { parsePostgres } from "./pg-parser.ts"
import { RESERVED_SCHEMA_WORDS } from "./pg-keywords.ts"

/** Whether Postgres's parser reads `name` as a schema name written unquoted */
function namesSchema(name: string): boolean {
	try {
		parsePostgres(`CREATE SCHEMA ${name}`)
		return true
	} catch {
		// reason: the parser refusing the name is the answer this asks for
		return false
	}
}

describe("RESERVED_SCHEMA_WORDS, held to the parser comb ships", () => {
	it("holds exactly the keywords Postgres refuses as an unquoted schema name", () => {
		const refused = PG_KEYWORDS.filter((word) => !namesSchema(word))
		expect(new Set(refused)).toEqual(RESERVED_SCHEMA_WORDS)
	})
})
