/** The range a number column holds and the bounds a written one takes, which the DTO checks and the manifest states. */
import type { FieldMeta } from "../../analyzer-types.ts"
import type { FieldConstraints } from "../../annotations.ts"
import type { Build } from "./build-types.ts"

/* Postgres stores c.integer in int4 */
const INT4 = { max: 2147483647, min: -2147483648 }

// lookup-table: the c helpers whose values are numbers or booleans, which numberBase types
const NUMBER_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"boolean",
	"createdAt",
	"deletedAt",
	"integer",
	"real",
	"serialId",
	"timestamp",
	"updatedAt",
])

/** Whether a column holds numbers: a comb number helper, or a drizzle column whose data type is one */
export const isNumeric = (field: FieldMeta): boolean =>
	field.combKind === null ? field.dataType.startsWith("number") : NUMBER_KINDS.has(field.combKind)

/** Whether a number column holds integers: c.integer, c.serialId, or a drizzle integer type */
export const isInteger = (field: FieldMeta): boolean =>
	field.combKind === null
		? field.dataType.startsWith("number int")
		: field.combKind === "integer" || field.combKind === "serialId"

/* the integer range each column holds: Postgres's int2 and int4, else a JS number's exact range */
const INT2 = { max: 32767, min: -32768 }
export type Range = { max: number; min: number }

export const SAFE: Range = { max: Number.MAX_SAFE_INTEGER, min: Number.MIN_SAFE_INTEGER }

/** A bound as generated code writes it, a JS number's exact range by its name */
export const boundCode = (bound: number): string =>
	bound === SAFE.max
		? "globalThis.Number.MAX_SAFE_INTEGER"
		: bound === SAFE.min
			? "globalThis.Number.MIN_SAFE_INTEGER"
			: String(bound)

/** The range an integer column holds, by what the dialect stores it in */
export function integerRange(field: FieldMeta, dialect: Build["dialect"]): Range {
	if (dialect === "sqlite") return SAFE
	if (field.combKind === "integer" || field.combKind === "serialId" || field.dataType === "number int32") return INT4
	return field.dataType === "number int16" ? INT2 : SAFE
}

/** A declared bound clamped to the column's, the column's where none is declared (CD8 of r22b) */
export const clamp = (declared: number | null, bound: number, pick: (a: number, b: number) => number): number =>
	declared === null ? bound : pick(declared, bound)

/** Refuses an integer's bounds, clamped to what the column holds, that leave no integer: every write would be refused (F8) */
export function refuseNoInteger(name: string, annotations: FieldConstraints, range: Range): void {
	const min = clamp(annotations.min, range.min, Math.max)
	const max = clamp(annotations.max, range.max, Math.min)
	if (Math.ceil(min) > Math.floor(max))
		throw new Error(`${name}: its bounds min ${min} and max ${max} leave no integer the column holds; widen them`)
}

/**
 * The bounds a written number of `field` takes, as numberBase checks them (C2 of r20): an integer's
 * and a timestamp's declared bounds clamped to what the column holds, a float's as declared, and
 * none on a boolean or a timestamp comb fills
 */
export function numberRules(field: FieldMeta, dialect: Build["dialect"]): { max: number | null; min: number | null } {
	const { max, min } = field.constraints
	const kind = field.combKind
	if (kind === "boolean" || kind === "createdAt" || kind === "updatedAt" || kind === "deletedAt")
		return { max: null, min: null }
	const range = kind === "timestamp" ? SAFE : isInteger(field) ? integerRange(field, dialect) : undefined
	if (range === undefined) return { max, min }
	return { max: clamp(max, range.max, Math.min), min: clamp(min, range.min, Math.max) }
}
