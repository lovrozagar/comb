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

/** Where the dtos generator writes each table's DTO schemas */
export type DtosConfig = {
	/** the stem of each file's name, `<filePrefix>.<table>.gen.ts`; each file is its directory's `index.gen.ts` when omitted */
	filePrefix?: string | undefined
	/** Package the generated meta stamp imports from. Matches EntitiesConfig. */
	importFrom?: string | undefined
	/** the directory each table's directory and `_shared/` are written under, relative to the codegen working directory */
	output: string
	/** where the relations generator writes, which the `./relations` export points at */
	relationsOutput?: string | undefined
	/** also export the files from the working directory's package.json, as `./dtos/<table>`, `./dtos/_shared`, `./relations` and `./tables`; warns when it has none */
	updatePackageJson?: boolean | undefined
}

/** Emitted code for a shared schema constant */
export type SharedSchema = { code: string; count: number; name: string }
