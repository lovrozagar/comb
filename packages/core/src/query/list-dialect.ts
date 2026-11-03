/**
 * The dialect a derived list is built for (Q1 of r21): the columns its id, anchor and keys hold decide,
 * wherever drizzle's SQL holds them (nested SQL, an aliased expression, a subquery's field), and a list
 * that holds none states it. A where's columns do not count: they are not what the cursor binds. Reads
 * only drizzle's public surface: `is()`, `Column.columnType`, `SQL.queryChunks`, `SQL.Aliased.sql`, and
 * a `Table` or `View` chunk's columns through `getTableColumns` and `getViewSelectedFields` (r22 Q3).
 */
import { Column, getTableColumns, getViewSelectedFields, is, SQL, type SQLWrapper, Table, View } from "drizzle-orm"

type ListDialect = "postgres" | "sqlite"

/** Each dialect whose column `wrapper` holds, however deep */
function dialectsIn(wrapper: unknown, found: Set<ListDialect>): Set<ListDialect> {
	if (is(wrapper, Column)) {
		const type = wrapper.columnType
		if (type.startsWith("Pg")) found.add("postgres")
		else if (type.startsWith("SQLite")) found.add("sqlite")
		else throw new TypeError(`a derived list reads Postgres or SQLite, but its id and keys hold a ${type} column`)
	} else if (is(wrapper, SQL)) {
		for (const chunk of wrapper.queryChunks) dialectsIn(chunk, found)
	} else if (is(wrapper, SQL.Aliased)) {
		dialectsIn(wrapper.sql, found)
	} else if (is(wrapper, Table)) {
		for (const column of Object.values(getTableColumns(wrapper))) dialectsIn(column, found)
	} else if (is(wrapper, View)) {
		for (const field of Object.values(getViewSelectedFields(wrapper))) dialectsIn(field, found)
	}
	return found
}

/**
 * The dialect of the list whose id and keys are `holders`: theirs, or `stated` where they hold no
 * column. The app's wiring, so a TypeError on every build: no column and no `dialect`, columns of
 * both dialects, a column of neither, or a `dialect` its columns contradict
 */
function listDialect(holders: readonly SQLWrapper[], stated: ListDialect | undefined): ListDialect {
	const found = new Set<ListDialect>()
	for (const holder of holders) dialectsIn(holder, found)
	const [only, other] = [...found]
	if (other !== undefined)
		throw new TypeError(
			`a derived list's id and keys hold columns of both ${only} and ${other}: build it over one dialect`,
		)
	if (only === undefined) {
		if (stated !== undefined) return stated
		throw new TypeError(
			'a derived list whose id and keys are all SQL expressions needs `dialect` ("postgres" or "sqlite"): no column says which database it reads',
		)
	}
	if (stated !== undefined && stated !== only)
		throw new TypeError(`a derived list states dialect "${stated}", but its id and keys hold ${only} columns`)
	return only
}

export { type ListDialect, listDialect }
