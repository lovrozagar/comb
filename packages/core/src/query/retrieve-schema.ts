/** The single-resource query schema: `select` and `lang`, plus any extension fields. */
import * as z from "zod"

import { langQueryField, pickExtended, selectQueryField } from "./schema-params.ts"
import type { RetrieveQueryConfig, RetrieveQueryOutput } from "./schema-types.ts"
import { validateSelectWithConfig } from "./select-validate.ts"

type RetrieveShape = { lang: z.ZodOptional<z.ZodString>; select: z.ZodOptional<z.ZodString> }
type RetrieveInput = z.ZodObject<RetrieveShape, z.core.$strip>

/** What createRetrieveQuerySchema returns: the request object piped into its parsed output */
type RetrieveQuerySchema<T extends z.ZodRawShape> = z.ZodPipe<
	RetrieveInput,
	z.ZodTransform<Awaited<RetrieveQueryOutput & { [K in keyof T]: z.infer<T[K]> }>, z.output<RetrieveInput>>
>

const baseRetrieveShape: RetrieveShape = {
	lang: langQueryField,
	select: selectQueryField,
}

const baseRetrieveSchema: RetrieveInput = /* @__PURE__ */ z.object(baseRetrieveShape)

function createRetrieveQuerySchema<T extends z.ZodRawShape = Record<string, never>>(
	config: RetrieveQueryConfig<T>,
): RetrieveQuerySchema<T> {
	const { extend: extendFields, fields: fieldsConfig } = config

	const schema = z.compile(extendFields ? z.object({ ...baseRetrieveShape, ...extendFields }) : baseRetrieveSchema)

	type ExtendedOutput = RetrieveQueryOutput & {
		[K in keyof T]: z.infer<T[K]>
	}

	const parsed = schema.transform((data, ctx): ExtendedOutput => ({
		lang: data.lang,
		parsedFields: validateSelectWithConfig(data.select, fieldsConfig, ctx),
		...(pickExtended(extendFields as Record<string, z.ZodType> | undefined, data) as {
			[K in keyof T]: z.infer<T[K]>
		}),
	}))
	/* with extensions the input object holds their keys too; the published type is the base request */
	return parsed as {} as RetrieveQuerySchema<T>
}

export { createRetrieveQuerySchema, type RetrieveQuerySchema }
