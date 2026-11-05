/** What the DTO generator's builders of one column take. */
import type { FieldMeta, ImportsMeta } from "../../analyzer-types.ts"
import type { FieldConstraints } from "../../annotations.ts"
import type { SchemaType, SharedName } from "./dto-types.ts"

/**
 * A builder's answer: the Zod base, whether it takes null itself (a read float, a written c.json's
 * union), so a nullable column adds no second null, the field's `x-comb-*` keys, which finish
 * writes on the property's own schema, beside the anyOf of a nullable one, the
 * shared schemas its code names, which the entity file imports, and the keys a nullable
 * states beside its anyOf alone, its member stating them otherwise: a nullable array's element keys
 * on its own `items`
 */
export type Base = {
	besideNull?: Record<string, unknown> | undefined
	code: string
	keys: Record<string, unknown>
	takesNull: boolean
	uses: readonly SharedName[]
}

/** A base that takes no null of its own */
export const plain = (code: string, keys: Record<string, unknown> = {}, uses: readonly SharedName[] = []): Base => ({
	code,
	keys,
	takesNull: false,
	uses,
})

/** The `.meta` that puts `keys` on the schema it follows; nothing for none */
export const metaOf = (keys: Record<string, unknown>): string =>
	Object.keys(keys).length === 0 ? "" : `.meta(${JSON.stringify(keys)})`

/**
 * `code` with `base`'s keys on it, nullable unless `takesNull`: the keys then sit on the nullable,
 * so they publish beside its anyOf, with its keys beside null too, and on its member,
 * so `.unwrap()` keeps them
 */
export const keyed = (code: string, base: Pick<Base, "besideNull" | "keys">, takesNull: boolean): string =>
	takesNull
		? `${code}${metaOf(base.keys)}`
		: `${code}${metaOf(base.keys)}.nullable()${metaOf({ ...base.keys, ...base.besideNull })}`

export type Build = {
	annotations: FieldConstraints
	dialect: "postgres" | "sqlite"
	/** whether the base is an array's element, whose read level states its keys on `items` alone */
	element?: boolean | undefined
	field: FieldMeta
	imports: ImportsMeta
	schemaType: SchemaType
}
