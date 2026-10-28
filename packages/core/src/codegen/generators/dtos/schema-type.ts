/** Which DTOs a schema type is: a write's, or a read's. */
import type { SchemaType } from "./dto-types.ts"

export const isMutative = (schemaType: SchemaType): boolean => schemaType === "create" || schemaType === "update"
export const isRead = (schemaType: SchemaType): boolean => schemaType === "read" || schemaType === "readPartial"
