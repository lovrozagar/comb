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

	/* Return null only when input was purely separators (no name tokens attempted).
	 * "author()" has a name token but skips the empty relation — root is empty but
	 * result must be non-null so callers can inspect root.relations.size === 0.
	 * ",,," has no name tokens at all — return null. */
	const hasContent = /[^,\s]/.test(selectStr)
	if (!hasContent) {
		return null
	}

	return {
		hasRelation: (name: string) => root.relations.has(name),
		root,
	}
}

function parseSelectList(str: string, start: number, end: number): FieldSelection {
	const selection: FieldSelection = {
		relations: new Map(),
		scalars: [],
	}

	let i = start
	while (i < end) {
		/* skip separators + whitespace */
		while (i < end && (str[i] === " " || str[i] === "," || str[i] === "\t" || str[i] === ")")) {
			i++
		}
		if (i >= end) break

		/* consume name up to next structural char */
		const nameStart = i
		while (i < end && str[i] !== "," && str[i] !== "(" && str[i] !== ")") {
			i++
		}
		const name = str.slice(nameStart, i).trim()

		if (!name) {
			continue
		}

		if (i < end && str[i] === "(") {
			/* relation embed */
			const parenStart = i + 1
			const parenEnd = findMatchingParen(str, i, end)
			const nested = parseSelectList(str, parenStart, parenEnd)
			if (nested.scalars.length === 0 && nested.relations.size === 0) {
				/* empty parens — skip the relation entirely; nothing selected */
			} else {
				mergeRelation(selection.relations, name, nested)
			}
			i = parenEnd < end ? parenEnd + 1 : end
		} else {
			/* scalar */
			if (!selection.scalars.includes(name)) {
				selection.scalars.push(name)
			}
		}
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

function mergeRelation(relations: Map<string, FieldSelection | null>, name: string, value: FieldSelection): void {
	const existing = relations.get(name)

	if (!existing) {
		relations.set(name, value)
	} else {
		for (const s of value.scalars) {
			if (!existing.scalars.includes(s)) {
				existing.scalars.push(s)
			}
		}
		for (const [k, v] of value.relations) {
			if (v !== null) mergeRelation(existing.relations, k, v)
		}
	}
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
		if (scalar in availableColumns) {
			columns[scalar as keyof T] = true as T[keyof T]
		}
	}

	return Object.keys(columns).length > 0 ? columns : undefined
}

function getRelationSelection(fields: ParsedFields | null, relationName: string): FieldSelection | null | undefined {
	if (!fields) {
		return null
	}

	if (!fields.root.relations.has(relationName)) {
		return undefined
	}

	return fields.root.relations.get(relationName)
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
			if (!selection.relations.has(key)) result[key] = data[key]
		}
	} else {
		for (const scalar of selection.scalars) {
			if (scalar in data) {
				result[scalar] = data[scalar]
			}
		}
	}

	for (const [relationName, nestedSelection] of selection.relations) {
		if (!(relationName in data)) continue

		const relationData = data[relationName]

		if (relationData === null || relationData === undefined) {
			result[relationName] = relationData
			continue
		}

		if (nestedSelection === null || nestedSelection.scalars.includes("*")) {
			/* wildcard at this level — pass through untouched */
			result[relationName] = relationData
			continue
		}

		if (Array.isArray(relationData)) {
			result[relationName] = relationData.map((item) => {
				if (typeof item !== "object" || item === null) return item
				return filterBySelection(item as Record<string, unknown>, nestedSelection)
			})
		} else if (typeof relationData === "object") {
			result[relationName] = filterBySelection(relationData as Record<string, unknown>, nestedSelection)
		} else {
			result[relationName] = relationData
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
	hasScalarsRequested,
	parseSelect,
}
