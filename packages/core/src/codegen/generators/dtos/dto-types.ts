/** Types the DTO generator's modules share. */
import type { CombEntityMetaInput } from "../../../meta.ts"

export type SchemaType = "read" | "readPartial" | "create" | "update"

export type FieldInfo = {
	key: string
	type: SchemaType
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
	timestampStyle: "camelCase" | "snake_case"
}

export type DtosConfig = {
	filePrefix?: string | undefined
	/** Package the generated meta stamp imports from. Matches EntitiesConfig. */
	importFrom?: string | undefined
	output: string
	updatePackageJson?: boolean
}

/** Emitted code for a shared schema constant */
export type SharedSchema = { code: string; count: number; name: string }
