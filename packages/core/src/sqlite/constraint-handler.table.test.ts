/* AB3-8 of area B: the table a foreign key violation names is the one SQLite deleted from, read as SQLite reads the statement */
import { describe, expect, it } from "vitest"
import { constraintError } from "./constraint-handler.ts"

/** What the handler answers for a foreign key violation behind `query` */
function fk(query: string) {
	const cause = Object.assign(new Error("FOREIGN KEY constraint failed"), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" })
	return constraintError(Object.assign(new Error(`Failed query: ${query}`, { cause }), { query }), [{ store: {} }])
}

describe("sqliteErrorHandler: the table a delete names", () => {
	it.each(['delete from "store";', "delete from 'store' where id = ?", "delete from main.'store'"])(
		"names the table %s deletes from",
		(query) => {
			expect(fk(query)).toMatchObject({ errorKey: "foreign_key_violation", table: "store" })
		},
	)
})
