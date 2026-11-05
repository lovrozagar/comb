/**
 * PA15 of r22b: a Postgres file's COPY rated by what it does, as the pinned Atlas runs it
 * (tests/integration/postgres/copy-execute-oracle.test.ts), never as a statement comb does not
 * recognize. Atlas's driver cannot run a COPY FROM STDIN or TO STDOUT, so the check refuses one; a
 * COPY that runs a program or writes a server file reaches past the database; a COPY from a server
 * file loads rows.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

/** `sql`'s rating after a table t, read as Postgres */
const rate = (sql: string) =>
	classifyMigration(sql, {
		before: extractSchema("CREATE TABLE t (id int);", undefined, "postgres"),
		dialect: "postgres",
	})

/** `sql`'s level and the notes its statements carry */
const rated = (sql: string) => {
	const { cautiousStatements, safety, unsafeStatements } = rate(sql)
	return { cautiousStatements, safety, unsafeStatements }
}

const STDIN =
	'Atlas\'s driver cannot run COPY FROM STDIN, so the file could never apply (it fails with "driver: bad connection"); write the rows as INSERT … VALUES'
const STDOUT =
	'Atlas\'s driver cannot run COPY TO STDOUT, so the file could never apply (it fails with "driver: bad connection"); a migration sends its rows to no one, so leave it out'

describe("a COPY with the client's stream, which Atlas cannot run (PA15 of r22b)", () => {
	it.each([
		["COPY t FROM STDIN;", STDIN],
		["COPY t (id) FROM STDIN WITH (FORMAT csv);", STDIN],
		["COPY t FROM STDIN;\n1\n\\.\n", STDIN],
		["COPY t TO STDOUT;", STDOUT],
		["COPY (SELECT 1) TO STDOUT;", STDOUT],
		["COPY t TO STDOUT WITH (FORMAT binary);", STDOUT],
	])("refuses %j at check, past any approval", (sql, why) => {
		const statement = sql.split(";")[0] as string
		expect(() => rate(sql)).toThrow(`${statement}: ${why}`)
		expect(() => rate(`-- comb:allow-unsafe: loads rows\n${sql}`)).toThrow(why)
	})
})

describe("a COPY with a server file or program (PA15 of r22b)", () => {
	it.each([
		["COPY t FROM PROGRAM 'true'", "runs a program on the database server as its operating-system user"],
		["COPY t TO PROGRAM 'cat'", "runs a program on the database server as its operating-system user"],
		["COPY t TO '/dev/null'", "writes a file on the database server"],
		["COPY (SELECT 1) TO '/dev/null'", "writes a file on the database server"],
	])("rates %j unsafe for what it reaches", (sql, note) => {
		expect(rated(`${sql};`)).toEqual({
			cautiousStatements: [],
			safety: "unsafe",
			unsafeStatements: [`${sql} (${note})`],
		})
	})

	it.each(["COPY t FROM '/dev/null'", "COPY t (id) FROM '/dev/null' WITH (FORMAT csv) WHERE id > 0"])(
		"rates %j cautious, as rows loaded into a table",
		(sql) => {
			expect(rated(`${sql};`)).toEqual({
				cautiousStatements: [`${sql} (loads rows into a table)`],
				safety: "cautious",
				unsafeStatements: [],
			})
		},
	)

	it("rates the query a COPY TO writes out by what it runs", () => {
		expect(rate("COPY (DELETE FROM t RETURNING id) TO '/dev/null';").unsafeStatements.join("\n")).toContain(
			"writes a file on the database server",
		)
		expect(rate("COPY (DELETE FROM t RETURNING id) TO '/dev/null';").unsafeStatements.join("\n")).not.toContain(
			"does not recognize",
		)
	})
})
