/**
 * What a consumer's compiler sees from the list and retrieve query schemas. Checked by
 * `bun run typecheck`; nothing here runs.
 */
import { expectTypeOf } from "vitest"
import * as z from "zod"
import { createListQuerySchema, createRetrieveQuerySchema } from "../../src/query/schema.ts"
import type { FilterAST, ParsedFields, SortField } from "../../src/query/types.ts"
import { buildListQuery } from "../../src/query/sqlite/build-list-query.ts"
import { keysetSQL, type KeysetPosition } from "../../src/query/sqlite/index.ts"
import { queryHelpers } from "../../src/query/drizzle.ts"
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

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

/* the parsed output feeds buildListQuery, and its result feeds countExtra, with no casts */
const post = sqliteTable("post", {
	created_at: integer("created_at"),
	id: text("id").primaryKey(),
	title: text("title"),
})
declare const parsed: ListOutput
const built = buildListQuery({ parsed, table: post })
expectTypeOf(queryHelpers.countExtra(built)).toEqualTypeOf<ReturnType<typeof queryHelpers.countExtra>>()
expectTypeOf(queryHelpers.countExtra(parsed)).toEqualTypeOf<ReturnType<typeof queryHelpers.countExtra>>()
// @ts-expect-error countExtra takes a parsed request or a built query, nothing else
queryHelpers.countExtra({ unrelated: true })

/* an extension whose input and output differ (a coercion) would change between the request and
   the parsed view; the config refuses it */
// @ts-expect-error extensions keep one type through parsing
createListQuerySchema({ extend: { archived: z.coerce.boolean().optional() }, sort: ["created_at"] })

/* keysetSQL's one argument has a name a consumer can import from the subpath that exports keysetSQL */
expectTypeOf(keysetSQL).parameter(0).toEqualTypeOf<KeysetPosition>()
