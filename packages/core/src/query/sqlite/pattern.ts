/**
 * The one lowering of `like` / `ilike` for SQLite. Every filter path calls this,
 * so the two operators cannot drift apart between builders.
 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"

import { globPattern, likePattern } from "../like.ts"

/** `like` → GLOB (case-sensitive). `ilike` → LIKE (ASCII case-insensitive). */
function patternToSQL(column: SQLWrapper, operator: "like" | "ilike", value: unknown): SQL {
	const raw = String(value)
	if (operator === "like") return sql`${column} GLOB ${globPattern(raw)}`
	return sql`${column} LIKE ${likePattern(raw)} ESCAPE '\\'`
}

export { patternToSQL }
