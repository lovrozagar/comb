/**
 * The single-resource query schema: `select`, `lang` when the endpoint declares it, and any
 * extension fields. The object is strict, as the list schema is: a param the endpoint does not
 * honor is a 400, not a 200 that ignores it.
 */
import * as z from "zod"

import { assertNotReserved, langQueryField, pickExtended, selectQueryField } from "./schema-params.ts"
import type { RetrieveQueryConfig, RetrieveQueryOutput } from "./schema-types.ts"
import { validateSelectWithConfig } from "./select-validate.ts"

type RetrieveShape = { lang?: z.ZodOptional<z.ZodString>; select: z.ZodOptional<z.ZodString> }
type RetrieveInput = z.ZodObject<RetrieveShape, z.core.$strict>

/** What createRetrieveQuerySchema returns: the request object piped into its parsed output */
type RetrieveQuerySchema<T extends z.ZodRawShape> = z.ZodPipe<
	RetrieveInput,
	z.ZodTransform<Awaited<RetrieveQueryOutput & { [K in keyof T]: z.infer<T[K]> }>, z.output<RetrieveInput>>
>

/* the params and output keys the schema owns; ReservedRetrieveKey in schema-types.ts is their type */
// lookup-table: the names an extension may not take
const RESERVED = /* @__PURE__ */ Object.freeze(["lang", "parsedFields", "select"])

function createRetrieveQuerySchema<T extends z.ZodRawShape = Record<string, never>>(
	config: RetrieveQueryConfig<T>,
): RetrieveQuerySchema<T> {
	const { extend: extendFields, fields: fieldsConfig } = config
	const extensions = extendFields as Record<string, z.ZodType> | undefined
	assertNotReserved("createRetrieveQuerySchema", extensions, RESERVED)

	const shape: RetrieveShape = { select: selectQueryField, ...(config.lang ? { lang: langQueryField } : {}) }
	const schema = z.compile(z.strictObject({ ...shape, ...extensions }))

	type ExtendedOutput = RetrieveQueryOutput & {
		[K in keyof T]: z.infer<T[K]>
	}

	const parsed = schema.transform((data, ctx): ExtendedOutput => ({
		lang: (data as { lang?: string }).lang,
		parsedFields: validateSelectWithConfig(data.select, fieldsConfig, ctx),
		...(pickExtended(extensions, data) as { [K in keyof T]: z.infer<T[K]> }),
	}))
	/* with extensions the input object holds their keys too; the published type is the base request */
	return parsed as {} as RetrieveQuerySchema<T>
}

export { createRetrieveQuerySchema, type RetrieveQuerySchema }
