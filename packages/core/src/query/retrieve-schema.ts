/** The single-resource query schema: `select` and `lang`, plus any extension fields. */
import * as z from "zod"

import { langQueryField, pickExtended, selectQueryField } from "./schema-params.ts"
import type { RetrieveQueryConfig, RetrieveQueryOutput } from "./schema-types.ts"
import { validateSelectWithConfig } from "./select-validate.ts"

const baseRetrieveShape = {
	lang: langQueryField,
	select: selectQueryField,
}

const baseRetrieveSchema = /* @__PURE__ */ z.object(baseRetrieveShape)

function createRetrieveQuerySchema<T extends z.ZodRawShape = Record<string, never>>(config: RetrieveQueryConfig<T>) {
	const { extend: extendFields, fields: fieldsConfig } = config

	const schema = z.compile(extendFields ? z.object({ ...baseRetrieveShape, ...extendFields }) : baseRetrieveSchema)

	type ExtendedOutput = RetrieveQueryOutput & {
		[K in keyof T]: z.infer<T[K]>
	}

	return schema.transform((data, ctx): ExtendedOutput => ({
		lang: data.lang,
		parsedFields: validateSelectWithConfig(data.select, fieldsConfig, ctx),
		...(pickExtended(extendFields as Record<string, z.ZodType> | undefined, data) as {
			[K in keyof T]: z.infer<T[K]>
		}),
	}))
}

export { createRetrieveQuerySchema }
