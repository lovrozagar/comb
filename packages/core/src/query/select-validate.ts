/**
 * `select=` against a FieldsConfig: the scalars and relations it declares, each relation's own
 * fields, and wildcards expanded to what is declared. Problems are issues on `select`.
 */
import type * as z from "zod"

import { parseSelect } from "./fields.ts"
import type { FieldsConfig } from "./schema-types.ts"
import type { FieldSelection, ParsedFields } from "./types.ts"

type Report = (message: string) => void

/** A relation by name, and the config that declares its fields */
type Relation = { fieldsConfig: FieldsConfig; name: string }

/** Report every name in `scalars` that `allowed` lacks; computed `@` fields are the handler's */
function checkScalars(scalars: readonly string[], allowed: ReadonlySet<string>, report: Report): void {
	for (const field of scalars) {
		if (!allowed.has(field) && !field.startsWith("@")) report(field)
	}
}

/** One selected relation: no relation below it, and only its declared fields when it declares any */
function checkRelation(selection: FieldSelection, { fieldsConfig, name }: Relation, report: Report): void {
	/* the config declares a relation's fields, never relations below it, so none is selectable */
	for (const nested of Object.keys(selection.relations)) report(`Unknown ${name} relation: ${nested}`)

	const relationFields = fieldsConfig.relationFields ?? {}
	if (!Object.hasOwn(relationFields, name)) return
	const allowed = new Set(relationFields[name])
	/* expand nested wildcard to all allowed fields */
	if (selection.scalars.includes("*")) selection.scalars = [...allowed]
	checkScalars(selection.scalars, allowed, (field) => report(`Unknown ${name} field: ${field}`))
}

/** The parsed selection, checked against `fieldsConfig`; null when there is none or it does not parse */
function validateSelectWithConfig(
	selectString: string | undefined,
	fieldsConfig: FieldsConfig,
	ctx: z.RefinementCtx,
): ParsedFields | null {
	if (!selectString || selectString.trim() === "") return null
	const report: Report = (message) => ctx.addIssue({ code: "custom", message, path: ["select"] })

	const parsed = parseSelect(selectString)
	if (!parsed) {
		report("Invalid select syntax")
		return null
	}

	/* Handle * wildcard at top level — expand to all scalars */
	if (parsed.root.scalars.includes("*")) parsed.root.scalars = [...fieldsConfig.scalars]
	checkScalars(parsed.root.scalars, new Set(fieldsConfig.scalars), (field) => report(`Unknown field: ${field}`))

	const relations = new Set(fieldsConfig.relations ?? [])
	/* parseSelect stores a selection for every embed, never null */
	for (const [name, selection] of Object.entries(parsed.root.relations) as Array<[string, FieldSelection]>) {
		if (relations.has(name)) checkRelation(selection, { fieldsConfig, name }, report)
		else report(`Unknown relation: ${name}`)
	}
	return parsed
}

export { validateSelectWithConfig }
