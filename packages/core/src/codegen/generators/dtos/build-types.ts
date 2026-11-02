/** What the DTO generator's builders of one column take. */
import type { FieldMeta, ImportsMeta } from "../../analyzer-types.ts"
import type { FieldConstraints } from "../../annotations.ts"
import type { SchemaType, SharedName } from "./dto-types.ts"

/** What each builder of one column's Zod expression takes */
/**
 * A builder's answer: the Zod base, whether it takes null itself (a read float, a written c.json's
 * union), so a nullable column adds no second null, the field's `x-comb-*` keys, which finish
 * writes on the property's own schema, beside the anyOf of a nullable one (C1, C4 of r19), and the
 * shared schemas its code names, which the entity file imports (C4 of r20)
 */
export type Base = { code: string; keys: Record<string, unknown>; takesNull: boolean; uses: readonly SharedName[] }

/** A base that takes no null of its own */
export const plain = (code: string, keys: Record<string, unknown> = {}, uses: readonly SharedName[] = []): Base => ({
	code,
	keys,
	takesNull: false,
	uses,
})

export type Build = {
	annotations: FieldConstraints
	dialect: "postgres" | "sqlite"
	field: FieldMeta
	imports: ImportsMeta
	schemaType: SchemaType
}
