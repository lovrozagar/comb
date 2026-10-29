/**
 * U1 of the 0.12 round: the README budgets 10 bound parameters for a three-key cursor, so a page of
 * the largest request the list schema accepts fits D1's 100. A key the keyset reads from the row
 * (a long text by reference, a SQLite number the cursor carried as null, a seconds-mode time) must keep within it too,
 * through both builders, whatever mix the keys hold and however they sort.
 */
import { SQLiteDialect, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SQL } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "./drizzle.ts"
import { createListQuerySchema } from "./schema.ts"
import { cursorWhere } from "./sqlite/cursor-where.ts"
import { SEALED } from "./__fixtures__/cursor-secret.ts"

const t = sqliteTable("t", {
	d1: integer("d1", { mode: "timestamp" }),
	d2: integer("d2", { mode: "timestamp" }),
	d3: integer("d3", { mode: "timestamp" }),
	id: integer("id").primaryKey(),
	r1: real("r1"),
	r2: real("r2"),
	r3: real("r3"),
	s1: text("s1"),
	s2: text("s2"),
	s3: text("s3"),
})
const COLUMNS = ["s1", "s2", "s3", "r1", "r2", "r3", "d1", "d2", "d3"] as const
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: [...COLUMNS] })
const dialect = new SQLiteDialect()
const LONG = "長".repeat(3000)

/** What a key holds on the cursor's row: a short text, a long text carried by reference, a null number, or a seconds-mode time */
type Kind = "null" | "plain" | "ref" | "time"
const KINDS: Kind[] = ["plain", "ref", "null", "time"]
const MIXES: Kind[][] = KINDS.flatMap((a) => KINDS.flatMap((b) => KINDS.map((c) => [a, b, c])))
const ORDERS = [
	["asc", "asc", "asc"],
	["desc", "desc", "desc"],
	["asc.nullsfirst", "desc.nullslast", "asc"],
	["desc.nullslast", "asc.nullsfirst", "desc.nullsfirst"],
]

/** The order string and the cursor's row for `mix` under `order` */
function request(mix: readonly Kind[], order: readonly string[]) {
	const row: Record<string, unknown> = { id: 7, r1: 1, r2: 2, r3: 3, s1: "a", s2: "b", s3: "c" }
	const fields = mix.map((kind, i) => {
		const field = kind === "null" ? `r${i + 1}` : kind === "time" ? `d${i + 1}` : `s${i + 1}`
		row[field] =
			kind === "null" ? null : kind === "ref" ? LONG : kind === "time" ? new Date(1_700_000_000_123) : row[field]
		return `${field}.${order[i]}`
	})
	return { order: fields.join(","), row }
}

const count = (where: SQL) => dialect.sqlToQuery(where).params.length

describe("a three-key cursor's parameters, by every mix of keys", () => {
	for (const order of ORDERS) {
		it.each(MIXES.map((mix) => [mix.join(", "), mix]))(
			`binds at most 10 for %s, sorted ${order.join(", ")}`,
			(_label, mix) => {
				const { order: given, row } = request(mix as Kind[], order)
				const parsed = schema.parse({ order: given })
				const [, meta] = queryHelpers.paginate([row, { ...row, id: 8 }], queryHelpers.listOptions(parsed, SEALED))
				const cursor = meta.nextCursor as string
				const keys = parsed.parsedSort.map(({ direction, field, nulls }) => ({
					column: t[field as (typeof COLUMNS)[number]],
					direction,
					nulls,
				}))
				const tiebreak = { column: t.id, direction: parsed.parsedSort[0]?.direction ?? "desc" }
				const built = cursorWhere({ cursor, keys, options: SEALED, sort: parsed.parsedSort, table: t, tiebreak })
				expect(count(built)).toBeLessThanOrEqual(10)
				const options = queryHelpers.listOptions(schema.parse({ cursor, order: given }), SEALED)
				const relational = (options.where as { RAW: (table: typeof t) => SQL }).RAW(t)
				expect(count(relational)).toBeLessThanOrEqual(10)
			},
		)
	}
})
