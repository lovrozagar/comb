/**
 * The schemas and the round trip of CD2 and CD3 of r22b (a `c.json` schema is the stored document),
 * which codegen/json-stored-document.test.ts runs on SQLite and codegen/pg-json-stored-document.test.ts
 * on a Postgres server, which macOS's runners have not
 */
import path from "node:path"
import type * as z from "zod"
import { generatedDir, generatedDtos } from "./dtos.ts"

export const DIALECTS = ["postgres", "sqlite"] as const
export type Dialect = (typeof DIALECTS)[number]

const IMPORTS = 'import * as z from "zod"\n'

/** A table whose one `doc` column is a c.json of `schema`, exported as `Doc` */
export const table = (dialect: Dialect, schema: string, column = 'c.json("doc", Doc).notNull()'): string =>
	`${IMPORTS}export const Doc = ${schema}
export const row = ${dialect === "postgres" ? "pgTable" : "sqliteTable"}("row", { id: c.text("id").primaryKey(), doc: ${column} })`

/** A schema whose output parses again, the body a create DTO takes, and the document it stores */
export type Kept = { body: unknown; kind: string; schema: string; stored: unknown }

export const KEPT: Kept[] = [
	{
		body: { name: "  Ada " },
		kind: "an overwrite",
		schema: "z.object({ name: z.string().trim().toLowerCase() })",
		stored: { name: "ada" },
	},
	{
		body: {},
		kind: "a default",
		schema: "z.object({ size: z.number().default(3), tags: z.array(z.string()).default([]) })",
		stored: { size: 3, tags: [] },
	},
	{ body: { size: "7" }, kind: "a coerce", schema: "z.object({ size: z.coerce.number() })", stored: { size: 7 } },
]

/** Insert `value` through the generated tables module `tables` into a fresh `row` table, and select it back */
export type Store = (tables: { row: never }, value: unknown) => Promise<unknown>

/** The DDL of the `row` table a store makes, on `dialect` */
export const rowDdl = (dialect: Dialect): string =>
	`CREATE TEMP TABLE row (id text PRIMARY KEY, doc ${dialect === "postgres" ? "jsonb" : "text"} NOT NULL)`

/** The read DTO's verdict on the row the create DTO's output stored on `dialect`, and that row's value */
export async function roundTrip(kept: Kept, dialect: Dialect, store: Store) {
	const name = `cd2-kept-${dialect}-${KEPT.indexOf(kept)}`
	const dtos = await generatedDtos(name, table(dialect, kept.schema), { dialect })
	const module = dtos["row"] as Record<string, z.ZodType>
	const created = (module["rowDtoCreateSchema"] as z.ZodType).parse({ doc: kept.body, id: "r1" }) as { doc: unknown }
	const tables = (await import(path.join(generatedDir(name), "db.x.tables.ts"))) as { row: never }
	const stored = await store(tables, created.doc)
	return { read: (module["rowDtoReadSchema"] as z.ZodType).safeParse({ doc: stored, id: "r1" }).success, stored }
}
