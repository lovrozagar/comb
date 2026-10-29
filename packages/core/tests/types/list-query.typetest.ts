/**
 * What a consumer's compiler sees from the list and retrieve query schemas. Checked by
 * `bun run typecheck`; nothing here runs.
 */
import { expectTypeOf } from "vitest"
import * as z from "zod"
import { createListQuerySchema, createRetrieveQuerySchema } from "../../src/query/schema.ts"
import type { ListQueryOutput } from "../../src/query/schema-types.ts"
import type { FilterAST, ParsedFields, SortField } from "../../src/query/types.ts"
import type { ListQueryInput } from "../../src/query/index.ts"
import { applyListQuery, buildListQuery, type ListExtras } from "../../src/query/sqlite/build-list-query.ts"
import { keysetSQL, type KeysetPosition } from "../../src/query/sqlite/index.ts"
import { queryHelpers } from "../../src/query/drizzle.ts"
import { getTableColumns } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { SEALED } from "../../src/query/__fixtures__/cursor-secret.ts"

const listSchema = createListQuerySchema({
	extend: { archived: z.enum(["yes", "no"]).optional() },
	filter: { status: "enum" },
	sort: ["created_at", "title"],
})
type ListOutput = z.output<typeof listSchema>

/* the parsed output carries the sort fields as a union, the extension typed by its schema */
expectTypeOf<ListOutput["parsedSort"]>().toEqualTypeOf<Array<SortField<"created_at" | "title">>>()
expectTypeOf<ListOutput["archived"]>().toEqualTypeOf<"yes" | "no" | undefined>()
expectTypeOf<ListOutput["filterAst"]>().toEqualTypeOf<FilterAST | null>()
expectTypeOf<ListOutput["parsedFields"]>().toEqualTypeOf<ParsedFields | null>()
expectTypeOf<ListOutput["limit"]>().toEqualTypeOf<number>()
expectTypeOf<ListOutput["cursor"]>().toEqualTypeOf<string | undefined>()

/* the request view is what a client may send */
expectTypeOf<z.input<typeof listSchema>>().toHaveProperty("order")
expectTypeOf<z.input<typeof listSchema>>().toHaveProperty("cursor")

const retrieveSchema = createRetrieveQuerySchema({
	extend: { expand: z.string().optional() },
	fields: { scalars: ["id"] },
})
expectTypeOf<z.output<typeof retrieveSchema>["expand"]>().toEqualTypeOf<string | undefined>()
expectTypeOf<z.output<typeof retrieveSchema>["parsedFields"]>().toEqualTypeOf<ParsedFields | null>()

/* the parsed output feeds buildListQuery, and its extras a select, with no casts */
const post = sqliteTable("post", {
	created_at: integer("created_at"),
	id: text("id").primaryKey(),
	title: text("title"),
})
declare const parsed: ListOutput
const built = buildListQuery({ ...SEALED, parsed, table: post })
expectTypeOf(built.extras).toEqualTypeOf<ListExtras>()

/* an extension whose input and output differ (a coercion) would change between the request and
   the parsed view; the config refuses it */
// @ts-expect-error extensions keep one type through parsing
createListQuerySchema({ extend: { archived: z.coerce.boolean().optional() }, sort: ["created_at"] })

/* keysetSQL's one argument has a name a consumer can import from the subpath that exports keysetSQL */
expectTypeOf(keysetSQL).parameter(0).toEqualTypeOf<KeysetPosition>()

/* Q7: the parsed query hands on the cursor as the raw string the client sent, and nothing decoded
   from it; only a verifying call (readCursor, listOptions, buildListQuery) reaches its values */
expectTypeOf<keyof ListQueryOutput<"created_at">>().toEqualTypeOf<
	| "cursor"
	| "filterAst"
	| "lang"
	| "limit"
	| "page"
	| "pageBounded"
	| "parsedFields"
	| "parsedSort"
	| "q"
	| "sortOrderBy"
	| "validated"
>()
expectTypeOf<z.output<ReturnType<typeof createListQuerySchema<Record<string, never>, ["created_at"]>>>>().toMatchTypeOf<
	ListQueryOutput<"created_at">
>()

/*
 * U29's type: a parsed object built by hand, as a handler that checks its own filter builds it,
 * compiles without `pageBounded`, which absent means checked against the default maxPage
 */
const handBuilt: ListQueryOutput = {
	cursor: undefined,
	filterAst: null,
	lang: undefined,
	limit: 20,
	page: 1,
	parsedFields: null,
	parsedSort: [],
	q: undefined,
	sortOrderBy: {},
	validated: true,
}
void handBuilt

/*
 * G2 of plan 14: the schema's own output agrees, so a ListQueryOutput passes where a handler takes
 * the schema's inferred output, as honey's generated handlers do
 */
const handler = (input: ListOutput) => input.limit
handler({ ...handBuilt, archived: undefined, parsedSort: [] })
expectTypeOf<ListOutput["pageBounded"]>().toEqualTypeOf<true | undefined>()

/* C12 of the 0.14.1 review, K9 of r17: applyListQuery builds drizzle's select as it is, or one made dynamic, over the extras */
declare const d1: DrizzleD1Database
const listed = sqliteTable("listed", { id: integer("id").primaryKey(), title: text("title") })
const listedQuery = buildListQuery({ ...SEALED, parsed: listSchema.parse({}), table: listed })
type Listed = { _combAnchorGone?: number; _combId?: unknown; _total?: number; id: number; title: string | null }
expectTypeOf(
	applyListQuery((extras) => d1.select({ ...getTableColumns(listed), ...extras }).from(listed), listedQuery),
).resolves.toEqualTypeOf<Listed[]>()
expectTypeOf(
	applyListQuery(
		(extras) =>
			d1
				.select({ ...getTableColumns(listed), ...extras })
				.from(listed)
				.$dynamic(),
		listedQuery,
	),
).resolves.toEqualTypeOf<Listed[]>()

/*
 * K6 and K10 of r17: every builder takes one exported ListQueryInput, its arrays read only, so the
 * schema's output and the README's hand-built `as const` query both pass, with no sortOrderBy
 */
const handParsed = {
	limit: 20,
	parsedSort: [{ direction: "desc", field: "created_at" }],
	validated: true,
} as const
queryHelpers.listOptions(handParsed, SEALED)
buildListQuery({ ...SEALED, parsed: handParsed, table: post })
const schemaInput: ListQueryInput<"created_at" | "title"> = parsed
const pageByHand = (input: ListQueryInput) => queryHelpers.listOptions(input, SEALED)
pageByHand(schemaInput)
expectTypeOf<ListQueryInput["parsedSort"]>().toEqualTypeOf<readonly SortField[]>()
