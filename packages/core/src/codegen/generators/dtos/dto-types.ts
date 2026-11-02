/** Types the DTO generator's modules share. */
import type { CombEntityMetaInput } from "../../../meta.ts"

export type SchemaType = "read" | "readPartial" | "create" | "update"

/** A schema the shared file defines that a field's code may name, which the entity file then imports */
export type SharedName = "cidrSchema" | "jsonValueSchema" | "timestampSchema"

export type FieldInfo = {
	key: string
	type: SchemaType
	/** The shared schemas the field's code names, as its builder says (C4 of r20) */
	uses: readonly SharedName[]
	zodType: string
}

export type TableInfo = {
	/** Entity facts stamped on the read schema; null when there is no single identity */
	combMeta: CombEntityMetaInput | null
	fields: FieldInfo[]
	hasTimestamps: {
		createdAt: boolean
		deletedAt: boolean
		updatedAt: boolean
	}
	name: string
	needsSharedMeta: boolean
	timestampStyle: "camelCase" | "mixed" | "snake_case"
}

export type DtosConfig = {
	filePrefix?: string | undefined
	/** Package the generated meta stamp imports from. Matches EntitiesConfig. */
	importFrom?: string | undefined
	output: string
	/** where the relations generator writes, which the `./relations` export points at */
	relationsOutput?: string | undefined
	updatePackageJson?: boolean
}

/** Emitted code for a shared schema constant */
export type SharedSchema = { code: string; count: number; name: string }
