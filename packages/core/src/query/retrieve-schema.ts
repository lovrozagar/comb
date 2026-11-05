/**
 * The single-resource query schema: `select`, `lang` when the endpoint declares it, and any
 * extension fields. The object is strict, as the list schema is: a param the endpoint does not
 * honor is a 400, not a 200 that ignores it.
 */
import * as z from "zod"

import {
	assertNotReserved,
	langQueryField,
	pickExtended,
	RESERVED_RETRIEVE_KEYS,
	selectQueryFieldFor,
} from "./schema-params.ts"
import type { RetrieveQueryConfig, RetrieveQueryOutput } from "./schema-types.ts"
import { validateSelectWithConfig } from "./select-validate.ts"

/* a zod shape: `lang` is absent or a schema, never undefined, as list-schema.ts's OptionalShape says */
/** The query params a single-resource endpoint takes, as zod schemas of their query-string text */
export type RetrieveShape = {
	/** the sparse fieldset */
	select: z.ZodOptional<z.ZodString>
} & Partial<{
	/** the language tag, present where the config sets `lang` */
	lang: z.ZodOptional<z.ZodString>
}>
/** A single-resource endpoint's request object, before it is parsed: strict, so any param it does not take is a 400 */
export type RetrieveRequest = z.ZodObject<RetrieveShape, z.core.$strict>

/** What createRetrieveQuerySchema returns: the request object piped into its parsed output */
type RetrieveQuerySchema<T extends z.ZodRawShape> = z.ZodPipe<
	RetrieveRequest,
	z.ZodTransform<Awaited<RetrieveQueryOutput & { [K in keyof T]: z.infer<T[K]> }>, z.output<RetrieveRequest>>
>

/**
 * The zod schema of a single-resource endpoint's query string: `select`, `lang` where declared, and
 * `extend`'s fields. An `extend` key the schema owns throws a TypeError at build
 */
function createRetrieveQuerySchema<T extends z.ZodRawShape = Record<never, never>>(
	config: RetrieveQueryConfig<T>,
): RetrieveQuerySchema<T> {
	const { extend: extendFields, fields: fieldsConfig } = config
	const extensions = extendFields as Record<string, z.ZodType> | undefined
	assertNotReserved("createRetrieveQuerySchema", extensions, RESERVED_RETRIEVE_KEYS)

	const shape: RetrieveShape = {
		select: selectQueryFieldFor(fieldsConfig),
		...(config.lang ? { lang: langQueryField } : {}),
	}
	const schema = z.strictObject({ ...shape, ...extensions })

	type ExtendedOutput = RetrieveQueryOutput & {
		[K in keyof T]: z.infer<T[K]>
	}

	const parsed = schema.transform((data, ctx): ExtendedOutput => ({
		lang: (data as { lang?: string | undefined }).lang,
		parsedFields: validateSelectWithConfig(data.select, fieldsConfig, ctx),
		...(pickExtended(extensions, data) as { [K in keyof T]: z.infer<T[K]> }),
	}))
	/* with extensions the input object holds their keys too; the published type is the base request */
	return parsed as {} as RetrieveQuerySchema<T>
}

export { createRetrieveQuerySchema, type RetrieveQuerySchema }
