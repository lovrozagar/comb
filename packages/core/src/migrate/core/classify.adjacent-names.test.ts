/**
 * SQLite reads a quoted, backticked or bracketed name as its own token, so `ALTER TABLE "users"DROP
 * COLUMN email` drops the column as `ALTER TABLE "users" DROP COLUMN email` does. Every spelling
 * without the whitespace beside such a name rates as the spelling with it.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { ExtractedSchema } from "../types.ts"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"
import { segments } from "../../sql-lexer.ts"

type Options = Parameters<typeof classifyMigration>[1]
type Case = { before?: number; options: Options; sql: string }

/* each non-Postgres classifyMigration call the classify unit tests made, with its options, recorded once each; a
 * Map or Set of a before schema is written as {$map} or {$set} */
const corpus = JSON.parse(
	readFileSync(new URL("../__fixtures__/classify-corpus.json", import.meta.url), "utf8"),
	(_, value: unknown) => {
		if (typeof value !== "object" || value === null) return value
		if ("$map" in value) return new Map(value.$map as Array<[unknown, unknown]>)
		return "$set" in value ? new Set(value.$set as unknown[]) : value
	},
) as { befores: ExtractedSchema[]; cases: Case[] }

/* a rating or refusal, whitespace dropped, since a note may quote the statement it rates */
function rating(sql: string, options: Options): string {
	try {
		return JSON.stringify(classifyMigration(sql, options)).replace(/\s+/g, "")
	} catch (error) {
		return `refused ${(error as Error).message.replace(/\s+/g, "")}`
	}
}

/** Each spelling of `sql` with the whitespace between one quoted name and a word beside it removed */
function adjacent(sql: string): string[] {
	const parts = segments(sql)
	const without = (at: number, trim: (text: string) => string) =>
		parts.map((part, i) => (i === at ? trim(part.text) : part.text)).join("")
	return parts.flatMap(({ kind }, i) => {
		if (kind !== "identifier") return []
		const before = parts[i - 1]
		const after = parts[i + 1]
		return [
			...(after?.kind === "code" && /^\s+[A-Za-z_]/.test(after.text)
				? [without(i + 1, (text) => text.trimStart())]
				: []),
			...(before?.kind === "code" && /[A-Za-z_]\s+$/.test(before.text)
				? [without(i - 1, (text) => text.trimEnd())]
				: []),
		]
	})
}

describe("a quoted name beside a word rates as with a space between (sweep of the classify corpus)", () => {
	const cases = corpus.cases.map(({ before, options, sql }) => ({
		options: before === undefined ? options : { ...options, before: corpus.befores[before] },
		sql,
	}))

	it("holds a corpus that spells names beside words", () => {
		expect(cases.flatMap(({ sql }) => adjacent(sql)).length).toBeGreaterThan(400)
	})

	it.each(cases.map((one, i) => [i, one] as const))("rates corpus case %i's adjacent spellings as it", (_, one) => {
		const spaced = rating(one.sql, one.options)
		for (const sql of adjacent(one.sql))
			expect({ rating: rating(sql, one.options), sql }).toEqual({ rating: spaced, sql })
	})
})

describe("an ALTER TABLE action against a quoted table name (the data-loss case)", () => {
	const before = extractSchema("CREATE TABLE users (id integer PRIMARY KEY, email text, n int);")
	const actions = ["DROP COLUMN email", "RENAME COLUMN email TO mail", "RENAME TO people", "ADD COLUMN c int NOT NULL"]

	it.each(['"users"', "`users`", "[users]"].flatMap((name) => actions.map((action) => [name, action])))(
		"rates ALTER TABLE %s%s unsafe, as with a space, and shows it as written",
		(name, action) => {
			const glued = classifyMigration(`ALTER TABLE ${name}${action};`, { before })
			expect(glued.safety).toBe(classifyMigration(`ALTER TABLE ${name} ${action};`, { before }).safety)
			expect(glued).toMatchObject({
				safety: "unsafe",
				unsafeStatements: [expect.stringMatching(`^ALTER TABLE \\${name[0]}users.${action}`)],
			})
		},
	)
})
