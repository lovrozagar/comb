/**
 * PostgREST-style sparse fieldset parser.
 *
 * Grammar:
 *   select      := entry ("," entry)*
 *   entry       := name ( "(" select ")" )?
 *   name        := /[^,()]+/ (trimmed)
 *
 * Rules:
 * - A name followed by "(" is a relation; the parens contain its own select expression.
 * - Without trailing "(" the name is a scalar.
 * - "*" is a valid scalar token at any level; downstream validators expand it.
 * - "@" prefix marks a computed field (anyrow extension). It is a literal scalar unless
 *   followed by "(" (no current use case defines a computed relation).
 *
 * Examples:
 *   "id,name"                 → scalars [id, name]
 *   "*"                       → scalars [*]
 *   "author(*)"               → relation author with scalars [*]
 *   "id,author(id,name)"      → scalars [id], relation author with [id, name]
 *   "author(posts(title))"    → relation author containing relation posts with scalars [title]
 *   "id,@totalPrice"          → scalars [id, @totalPrice]
 *
 * Clean break from legacy "~" prefix + "." dot-path nesting — those characters are
 * now literal and downstream validators will reject them as unknown field names.
 */
import type { FieldSelection, ParsedFields } from "./types.ts"

function parseSelect(selectStr: string | undefined): ParsedFields | null {
	if (!selectStr || selectStr.trim() === "") {
		return null
	}

	const root = parseSelectList(selectStr, 0, selectStr.length)
	if (root === null) return null

	/* Return null only when input was purely separators (no name tokens attempted).
	 * "author()" has a name token but skips the empty relation — root is empty but
	 * result must be non-null so callers can inspect the empty root.
	 * ",,," has no name tokens at all — return null. */
	const hasContent = /[^,\s]/.test(selectStr)
	if (!hasContent) {
		return null
	}

	return { root }
}

const SEPARATORS = /[ ,\t)]/
const NAME_END = /[,()]/

type Span = { end: number; str: string }

/** The first index at or after `from`, before `span.end`, where `test` matches; else `span.end` */
function scan(span: Span, from: number, test: (char: string) => boolean): number {
	let i = from
	while (i < span.end && !test(span.str[i] as string)) i++
	return i
}

/**
 * Add the embed `name(...)` opening at `open` to `selection`; returns where parsing resumes, or
 * null when the embed's contents are malformed. Empty parens select nothing and add nothing.
 */
function addEmbed(
	selection: FieldSelection,
	name: string,
	at: { end: number; open: number; str: string },
): number | null {
	const close = findMatchingParen(at.str, at.open, at.end)
	const nested = parseSelectList(at.str, at.open + 1, close)
	if (nested === null) return null
	if (nested.scalars.length > 0 || Object.keys(nested.relations).length > 0)
		mergeRelation(selection.relations, name, nested)
	return close < at.end ? close + 1 : at.end
}

/** The selection between `start` and `end`, or null when an embed has no name before its `(` */
function parseSelectList(str: string, start: number, end: number): FieldSelection | null {
	const selection: FieldSelection = { relations: {}, scalars: [] }
	const span = { end, str }
	let i = scan(span, start, (char) => !SEPARATORS.test(char))
	while (i < end) {
		const nameEnd = scan(span, i, (char) => NAME_END.test(char))
		const name = str.slice(i, nameEnd).trim()
		/* separators were skipped, so an empty name means "(" with nothing before it */
		if (!name) return null
		if (str[nameEnd] === "(" && nameEnd < end) {
			const next = addEmbed(selection, name, { end, open: nameEnd, str })
			if (next === null) return null
			i = next
		} else {
			if (!selection.scalars.includes(name)) selection.scalars.push(name)
			i = nameEnd
		}
		i = scan(span, i, (char) => !SEPARATORS.test(char))
	}
	return selection
}

function findMatchingParen(str: string, openPos: number, end: number): number {
	let depth = 1
	let i = openPos + 1
	while (i < end && depth > 0) {
		if (str[i] === "(") depth++
		else if (str[i] === ")") depth--
		i++
	}
	return depth === 0 ? i - 1 : end
}

/**
 * Set `record[key]` as an own property. Plain assignment of `__proto__` would replace the
 * prototype instead, and a request names keys freely.
 */
function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, { configurable: true, enumerable: true, value, writable: true })
}

function mergeRelation(relations: Record<string, FieldSelection | null>, name: string, value: FieldSelection): void {
	const existing = Object.hasOwn(relations, name) ? relations[name] : undefined

	if (!existing) {
		setOwn(relations, name, value)
	} else {
		for (const s of value.scalars) {
			if (!existing.scalars.includes(s)) {
				existing.scalars.push(s)
			}
		}
		/* parseSelectList stores a selection for every embed, never null */
		for (const [k, v] of Object.entries(value.relations) as Array<[string, FieldSelection]>) {
			mergeRelation(existing.relations, k, v)
		}
	}
}

function hasRelation(fields: ParsedFields | null, name: string): boolean {
	if (!fields) return false
	return Object.hasOwn(fields.root.relations, name)
}

function buildColumns<T extends Record<string, true>>(
	requestedScalars: string[],
	availableColumns: T,
): Partial<T> | undefined {
	if (requestedScalars.length === 0) {
		return undefined
	}

	const columns: Partial<T> = {}
	for (const scalar of requestedScalars) {
		if (Object.hasOwn(availableColumns, scalar)) {
			columns[scalar as keyof T] = true as T[keyof T]
		}
	}

	return Object.keys(columns).length > 0 ? columns : undefined
}

function getRelationSelection(fields: ParsedFields | null, relationName: string): FieldSelection | null | undefined {
	if (!fields) {
		return null
	}

	if (!Object.hasOwn(fields.root.relations, relationName)) {
		return undefined
	}

	return fields.root.relations[relationName]
}

function buildRelationColumns<T extends Record<string, true>>(
	nestedSelection: FieldSelection | null,
	availableColumns: T,
): Partial<T> | undefined {
	if (nestedSelection === null) {
		return undefined
	}

	return buildColumns(nestedSelection.scalars, availableColumns)
}

function hasScalarsRequested(fields: ParsedFields | null, availableScalars: string[]): boolean {
	if (!fields) {
		return true
	}

	for (const scalar of fields.root.scalars) {
		if (availableScalars.includes(scalar)) {
			return true
		}
	}

	return false
}

function getEntityColumns<T extends Record<string, true>>(
	fields: ParsedFields | null,
	availableColumns: T,
): Partial<T> | undefined {
	if (!fields) {
		return undefined
	}

	return buildColumns(fields.root.scalars, availableColumns)
}

function filterBySelect<T extends Record<string, unknown>>(data: T, fields: ParsedFields): Partial<T> {
	return filterBySelection(data, fields.root) as Partial<T>
}

function filterBySelection(data: Record<string, unknown>, selection: FieldSelection): Record<string, unknown> {
	const result: Record<string, unknown> = {}

	const hasWildcard = selection.scalars.includes("*")

	if (hasWildcard) {
		for (const key of Object.keys(data)) {
			/* skip keys that are explicitly selected as nested relations — handled below */
			if (!Object.hasOwn(selection.relations, key)) setOwn(result, key, data[key])
		}
	} else {
		for (const scalar of selection.scalars) {
			if (Object.hasOwn(data, scalar)) setOwn(result, scalar, data[scalar])
		}
	}

	for (const [relationName, nestedSelection] of Object.entries(selection.relations)) {
		if (!Object.hasOwn(data, relationName)) continue

		const relationData = data[relationName]

		if (relationData === null || relationData === undefined) {
			setOwn(result, relationName, relationData)
			continue
		}

		if (nestedSelection === null || nestedSelection.scalars.includes("*")) {
			/* wildcard at this level — pass through untouched */
			setOwn(result, relationName, relationData)
			continue
		}

		if (Array.isArray(relationData)) {
			const items = relationData.map((item: unknown) =>
				typeof item === "object" && item !== null
					? filterBySelection(item as Record<string, unknown>, nestedSelection)
					: item,
			)
			setOwn(result, relationName, items)
		} else if (typeof relationData === "object") {
			setOwn(result, relationName, filterBySelection(relationData as Record<string, unknown>, nestedSelection))
		} else {
			setOwn(result, relationName, relationData)
		}
	}

	return result
}

export {
	buildColumns,
	buildRelationColumns,
	filterBySelect,
	getEntityColumns,
	getRelationSelection,
	hasRelation,
	hasScalarsRequested,
	parseSelect,
}
