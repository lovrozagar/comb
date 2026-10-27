/**
 * U43: an UPDATE, or an upsert's DO UPDATE, that assigns a column other tables reference may have
 * failed on either side: its own key, or a row that references the old value. Which one SQLite
 * does not say, so the handler answers the neutral cause, as it does for a key a map leaves out.
 */
import { describe, expect, it } from "vitest"
import type { ConstraintMap } from "../types.ts"
import { constraintError } from "./constraint-handler.ts"

const MAPS: ConstraintMap[] = [
	{
		store: {
			foreignKey: { owner_id: { cause: "No such owner", errorKey: "store_owner_missing" } },
			referenced: ["id"],
		},
		team: { foreignKey: { org_id: { cause: "Organization not found", errorKey: "team_org_missing" } } },
	},
]

/** What the handler answers for a foreign key violation behind `query`, under `maps` */
function fk(query: string, maps = MAPS) {
	const cause = Object.assign(new Error("FOREIGN KEY constraint failed"), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" })
	return constraintError(Object.assign(new Error(`Failed query: ${query}`, { cause }), { query }), maps)
}

const NEUTRAL = {
	cause: "Referenced record does not exist or is still in use",
	column: undefined,
	errorKey: "foreign_key_violation",
	table: "store",
}

describe("sqliteErrorHandler: a statement that changes a key other tables reference", () => {
	it("answers an UPDATE assigning a referenced column with the neutral cause, its own key assigned too", () => {
		expect(fk('update "store" set "id" = ? where "id" = ?')).toMatchObject(NEUTRAL)
		expect(fk('update "store" set "owner_id" = ?, "ID" = ? where "id" = ?')).toMatchObject(NEUTRAL)
	})

	it("answers an upsert whose DO UPDATE SET assigns a referenced column with the neutral cause", () => {
		expect(
			fk('insert into "store" ("id", "owner_id") values (?, ?) on conflict ("id") do update set "id" = 99'),
		).toMatchObject(NEUTRAL)
		expect(
			fk(
				'insert into "store" ("id", "owner_id") values (?, ?) on conflict do update set "name" = excluded."name", "id" = excluded."id" where "store"."id" > 0',
			),
		).toMatchObject(NEUTRAL)
	})

	it("blames the row's own key when the statement assigns no referenced column", () => {
		expect(fk('update "store" set "name" = ?, "owner_id" = ? where "id" = ?')).toMatchObject({
			column: "owner_id",
			errorKey: "store_owner_missing",
		})
		/* an upsert's insert path sets the row's own key; a DO UPDATE of other columns leaves it the cause */
		expect(
			fk('insert into "team" ("id", "org_id") values (?, ?) on conflict ("id") do update set "name" = excluded."name"'),
		).toMatchObject({ column: "org_id", errorKey: "team_org_missing" })
	})

	it("keeps today's answer under a map that lists no referenced columns", () => {
		const unlisted: ConstraintMap[] = [
			{ store: { foreignKey: { owner_id: { cause: "x", errorKey: "store_owner_missing" } } } },
		]
		expect(fk('update "store" set "owner_id" = ?, "id" = ?', unlisted)).toMatchObject({
			errorKey: "store_owner_missing",
		})
	})
})
