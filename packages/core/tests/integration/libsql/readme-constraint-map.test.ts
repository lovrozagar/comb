/**
 * QE4 of r22b: README's constraint-map example keyed its unique and its foreign key by constraint
 * name, which only the Postgres handler matches; on libsql both entries went unused and the
 * violation got the generic answer. The example is now keyed as codegen writes it, and runs here
 * as written through classifySqliteError.
 */
import { sql } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { classifySqliteError } from "../../../src/sqlite/constraint-handler.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"
import { README_MAP_CASES, README_MAP_DDL, readmeConstraintMap } from "../support/readme-constraint-map.ts"

describe("README's constraint map on libsql (QE4 of r22b; sibling: the D1 handler)", () => {
	let harness: LibsqlHarness

	beforeEach(async () => {
		harness = libsqlMemory()
		await harness.client.execute("PRAGMA foreign_keys = ON")
		for (const statement of README_MAP_DDL) await harness.client.execute(statement)
	})

	afterEach(() => harness.close())

	it.each(README_MAP_CASES)("maps $label as the README says", async ({ errorKey, statement, status }) => {
		/* through drizzle, as an app reads it: its error carries the statement, which names the table */
		const failure = await harness.db.run(sql.raw(statement)).then(
			() => new Error("the statement did not fail"),
			(error: unknown) => error,
		)
		expect(classifySqliteError(failure, [readmeConstraintMap()])).toMatchObject({ errorKey, status })
	})
})
