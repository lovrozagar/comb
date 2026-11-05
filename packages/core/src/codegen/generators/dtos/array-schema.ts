/** The DTO generator's Zod base of a Postgres array column, built of its element's base. */
import { type Base, keyed, metaOf, plain } from "./build-types.ts"
import type { SchemaType } from "./dto-types.ts"
import { isMutative } from "./schema-type.ts"

/* Postgres keeps at most 6 dimensions (MAXDIM) */
const MAX_DIMENSIONS = 6

/* Postgres refuses a ragged multidimensional array: each level's sub-arrays must share one shape */
const RECTANGULAR =
	'.refine((value) => { const shape = (part: unknown): string => (globalThis.Array.isArray(part) ? `${part.length}[${[...new globalThis.Set(part.map(shape))].join("|")}]` : ""); return !shape(value).includes("|") }, { message: "Must be a rectangular array: every sub-array of a level the same length" })'

/**
 * An array column's shape: its declared dimensions, whether a written element takes null, as the
 * column's drizzle type declares it, and the DTO it is built for
 */
type Shape = { dimensions: number; nullable: boolean; schemaType: SchemaType }

/**
 * The base of an array column of `element`s, which takes null by its own column alone, whatever its
 * elements take: a written one past one dimension is rectangular, a key finish places as any other,
 * and a nullable one states its element's keys on its own `items` beside
 * its anyOf, as its array member does
 */
export function arrayBase(element: Base, shape: Shape): Base {
	const keys = shape.dimensions > 1 && isMutative(shape.schemaType) ? { "x-comb-rectangular": true } : {}
	return { ...plain(arrayOf(element, shape), keys), besideNull: itemsKeys(element, shape) }
}

/**
 * An array column of `element`s: written, in exactly its declared dimensions, rectangular past one;
 * read, in any depth Postgres holds, as it keeps no declared dimensions and a read never refuses a
 * stored row. A read level's items is the element or a deeper array, a union that carries the
 * element's keys, so every level's `items` states them and no anyOf member alone does
 */
function arrayOf(element: Base, { dimensions, nullable, schemaType }: Shape): string {
	/* the element is nullable where its type says, a read's always, its keys on it, which publish on `items` */
	const read = !isMutative(schemaType)
	let nested = `z.array(${keyed(element.code, element, element.takesNull || !(read || nullable))})`
	if (read) {
		const bare = element.takesNull ? element.code : `${element.code}.nullable()`
		for (let depth = 1; depth < MAX_DIMENSIONS; depth++)
			nested = `z.array(z.union([${bare}, ${nested}])${metaOf(element.keys)})`
		return nested
	}
	for (let depth = 1; depth < dimensions; depth++) nested = `z.array(${nested})`
	return dimensions > 1 ? `${nested}${RECTANGULAR}` : nested
}

/**
 * The element's keys as the array's own `items` states them: a written array's innermost level, a
 * read's first, as each of its levels carries them. JSON Schema's `items` binds an array alone, so a
 * null still passes
 */
function itemsKeys(element: Base, { dimensions, schemaType }: Shape): Record<string, unknown> {
	if (Object.keys(element.keys).length === 0) return {}
	let items: Record<string, unknown> = { items: element.keys }
	for (let depth = 1; isMutative(schemaType) && depth < dimensions; depth++) items = { items }
	return items
}
