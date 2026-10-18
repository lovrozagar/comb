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
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import type { FieldSelection, ParsedFields } from "./types.ts"

/** Relations nested deeper than this are refused: each level is a join, and the parse recurses per level */
const MAX_SELECT_DEPTH: number = 8
const TOO_DEEP: string = `select nests relations deeper than ${MAX_SELECT_DEPTH} levels`

/** The parsed selection; null when empty or malformed; "too_deep" past MAX_SELECT_DEPTH */
function readSelect(selectStr: string | undefined): ParsedFields | null | "too_deep" {
	if (!selectStr || selectStr.trim() === "") {
		return null
	}

	const text: Text = { closes: matchParens(selectStr), str: selectStr }
	const root = parseSelectList(text, { end: selectStr.length, start: 0 }, 0)
	if (root === null || root === "too_deep") return root

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

/** The parsed selection, or null when empty or malformed; nesting past MAX_SELECT_DEPTH is a 400 */
function parseSelect(selectStr: string | undefined): ParsedFields | null {
	const read = readSelect(selectStr)
	if (read !== "too_deep") return read
	throw new CombError({ cause: TOO_DEEP, errorKey: combErrorKeys.INVALID_SELECT, status: "bad_request" })
}

const SEPARATORS = /[ ,\t)]/
const NAME_END = /[,()]/

type Span = { end: number; str: string }
/** The input and, for each `(`, the index of its matching `)` (the input's length when unclosed) */
type Text = { closes: Map<number, number>; str: string }
type Range = { end: number; start: number }

/** Every `(` matched to its `)` in one pass: the parse then never rescans a span to find a close */
function matchParens(str: string): Map<number, number> {
	const closes = new Map<number, number>()
	const open: number[] = []
	for (let i = 0; i < str.length; i++) {
		if (str[i] === "(") open.push(i)
		else if (str[i] === ")" && open.length > 0) closes.set(open.pop() as number, i)
	}
	for (const at of open) closes.set(at, str.length)
	return closes
}

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
	at: { depth: number; open: number; range: Range; text: Text },
): number | null | "too_deep" {
	const close = Math.min(at.text.closes.get(at.open) as number, at.range.end)
	const nested = parseSelectList(at.text, { end: close, start: at.open + 1 }, at.depth + 1)
	if (nested === null || nested === "too_deep") return nested
	if (nested.scalars.length > 0 || Object.keys(nested.relations).length > 0)
		mergeRelation(selection.relations, name, nested)
	return close < at.range.end ? close + 1 : at.range.end
}

/** The selection within `range` at `depth`, or null when an embed has no name before its `(` */
function parseSelectList(text: Text, range: Range, depth: number): FieldSelection | null | "too_deep" {
	if (depth > MAX_SELECT_DEPTH) return "too_deep"
	const selection: FieldSelection = { relations: {}, scalars: [] }
	const span = { end: range.end, str: text.str }
	let i = scan(span, range.start, (char) => !SEPARATORS.test(char))
	while (i < range.end) {
		const nameEnd = scan(span, i, (char) => NAME_END.test(char))
		const name = text.str.slice(i, nameEnd).trim()
		/* separators were skipped, so an empty name means "(" with nothing before it */
		if (!name) return null
		if (text.str[nameEnd] === "(" && nameEnd < range.end) {
			const next = addEmbed(selection, name, { depth, open: nameEnd, range, text })
			if (next === null || next === "too_deep") return next
			i = next
		} else {
			if (!selection.scalars.includes(name)) selection.scalars.push(name)
			i = nameEnd
		}
		i = scan(span, i, (char) => !SEPARATORS.test(char))
	}
	return selection
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
	MAX_SELECT_DEPTH,
	parseSelect,
	readSelect,
	TOO_DEEP,
}
