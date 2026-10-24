/** Facts about one column that several generators ask for, read from its FieldMeta */
import type { FieldMeta } from "./analyzer-types.ts"

/** Whether a column references another: `.references(...)`, or the c.ref helper, which always does */
export function isReference(field: Pick<FieldMeta, "combKind" | "foreignKey">): boolean {
	return field.foreignKey !== null || field.combKind === "ref"
}
