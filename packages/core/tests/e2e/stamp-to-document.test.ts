/**
 * End to end: a comb table definition → generated DTO → JSON Schema → the key
 * honey reads off it.
 *
 * The generated file is imported and executed, not string-matched, so this
 * covers the whole trip including the `@lovrozagar/comb/meta` import the
 * generator emits. Assertions are on the exact JSON Schema, because "the object
 * is non-empty" would pass even if the stamp landed somewhere honey never looks.
 */
import fs from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as z from "zod"
import { analyze } from "../../src/codegen/analyzer.ts"
import { generateDtos } from "../../src/codegen/generators/dtos.ts"
import { COMB_META_KEY, readCombEntityMeta, readCombQueryMeta } from "../../src/meta.ts"
import { createListQuerySchema } from "../../src/query/schema.ts"
import { depthOfKey, readRootKey, searchSchemaKey } from "./honey-search.ts"

/* Generated inside the package so the emitted `@lovrozagar/comb/meta` import
   resolves through the workspace. `.tmp-*` is gitignored. */
const WORK_DIR = path.resolve(import.meta.dirname, ".tmp-stamp-e2e")

const TABLES = `
import { sqliteTable as createTable, text, integer } from "drizzle-orm/sqlite-core"
const c = {
	id: (_p: string) => text("id").primaryKey(),
	text: (n: string, _o?: { max?: number; nomutate?: boolean }) => text(n),
	ref: (n: string) => text(n),
	createdAt: (n: string) => integer(n, { mode: "number" }).notNull(),
	updatedAt: (n: string) => integer(n, { mode: "number" }).notNull(),
	deletedAt: (n: string) => integer(n, { mode: "number" }),
}
export const author = createTable("author", { id: c.id("aut"), name: c.text("name") })
export const article = createTable("article", {
	id: c.id("art"),
	author_id: c.ref("author_id").references(() => author.id),
	slug: c.text("slug", { nomutate: true }),
	title: c.text("title", { max: 200 }),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
	deleted_at: c.deletedAt("deleted_at"),
})
`

type Generated = { articleDtoReadSchema: z.ZodObject }

let generated: Generated

beforeAll(async () => {
	fs.rmSync(WORK_DIR, { force: true, recursive: true })
	fs.mkdirSync(WORK_DIR, { recursive: true })
	const tablesPath = path.join(WORK_DIR, "db.blog.tables.ts")
	fs.writeFileSync(tablesPath, TABLES)

	const analysis = analyze(tablesPath)
	generateDtos(analysis, tablesPath, { output: path.join(WORK_DIR, "dtos") }, WORK_DIR)

	generated = (await import(path.join(WORK_DIR, "dtos", "article", "index.gen.ts"))) as Generated
})

afterAll(() => {
	fs.rmSync(WORK_DIR, { force: true, recursive: true })
})

/* The facts the generator derives for the fixture above. Written out in full so
   a change to the derivation shows up here as a diff, not as a silent pass. */
const EXPECTED_ENTITY = {
	generated: ["id", "created_at", "updated_at", "deleted_at"],
	identity: "id",
	immutable: ["id", "author_id", "slug", "created_at", "updated_at", "deleted_at"],
	kind: "entity",
	name: "article",
	softDelete: "deleted_at",
	tenantColumn: null,
	v: 1,
}

describe("entity stamp — bare item schema", () => {
	it("lands on the JSON Schema root, verbatim", () => {
		const json = z.toJSONSchema(generated.articleDtoReadSchema) as Record<string, unknown>
		expect(json[COMB_META_KEY]).toEqual(EXPECTED_ENTITY)
	})

	it("is a sibling of the schema's own keywords, not nested inside them", () => {
		const json = z.toJSONSchema(generated.articleDtoReadSchema) as Record<string, unknown>
		expect(json["type"]).toBe("object")
		expect(Object.keys(json)).toContain(COMB_META_KEY)
		/* honey reads the root; anything under properties/items would be missed by search: "root" */
		expect(JSON.stringify(json["properties"])).not.toContain(COMB_META_KEY)
	})

	it("is found by honey's root search at depth 0", () => {
		const json = z.toJSONSchema(generated.articleDtoReadSchema) as Record<string, unknown>
		expect(readRootKey(json, COMB_META_KEY)).toEqual({ found: true, value: EXPECTED_ENTITY })
		expect(depthOfKey(json, COMB_META_KEY)).toBe(0)
	})

	it("survives both io views", () => {
		for (const io of ["input", "output"] as const) {
			const json = z.toJSONSchema(generated.articleDtoReadSchema, { io }) as Record<string, unknown>
			expect(readCombEntityMeta(json)).toEqual(EXPECTED_ENTITY)
		}
	})
})

describe("entity stamp — bare array output", () => {
	it("sits under items, where honey's root search sees it through one level", () => {
		const json = z.toJSONSchema(z.array(generated.articleDtoReadSchema)) as Record<string, unknown>

		expect(json["type"]).toBe("array")
		expect(json[COMB_META_KEY]).toBeUndefined()
		expect((json["items"] as Record<string, unknown>)[COMB_META_KEY]).toEqual(EXPECTED_ENTITY)

		expect(readRootKey(json, COMB_META_KEY)).toEqual({ found: true, value: EXPECTED_ENTITY })
		expect(depthOfKey(json, COMB_META_KEY)).toBe(1)
	})
})

describe("entity stamp — pagination envelope", () => {
	/* The shape a comb-backed list endpoint actually returns. */
	const envelope = () =>
		z.object({
			articles: z.array(generated.articleDtoReadSchema),
			count: z.number().int(),
			hasMore: z.boolean(),
			nextCursor: z.string().nullable(),
		})

	it("sits at properties.articles.items, and nowhere shallower", () => {
		const json = z.toJSONSchema(envelope()) as Record<string, unknown>
		const props = json["properties"] as Record<string, Record<string, unknown>>

		expect(json[COMB_META_KEY]).toBeUndefined()
		expect(props["articles"]![COMB_META_KEY]).toBeUndefined()
		expect((props["articles"]!["items"] as Record<string, unknown>)[COMB_META_KEY]).toEqual(EXPECTED_ENTITY)
	})

	it("is invisible to honey's root search — deep is required for this shape", () => {
		const json = z.toJSONSchema(envelope()) as Record<string, unknown>
		expect(readRootKey(json, COMB_META_KEY)).toEqual({ found: false })
	})

	it("is found by honey's deep search at depth 2, well inside its limit of 6", () => {
		const json = z.toJSONSchema(envelope()) as Record<string, unknown>

		expect(depthOfKey(json, COMB_META_KEY)).toBe(2)
		expect(searchSchemaKey(json, COMB_META_KEY)).toEqual({ found: true, value: EXPECTED_ENTITY })
	})

	it("is not confused by sidecar keys at the same depth", () => {
		const json = z.toJSONSchema(envelope()) as Record<string, unknown>
		const props = json["properties"] as Record<string, unknown>
		/* count / hasMore / nextCursor are visited at depth 1 alongside the array */
		expect(Object.keys(props).sort()).toEqual(["articles", "count", "hasMore", "nextCursor"])
		expect(searchSchemaKey(json, COMB_META_KEY).found).toBe(true)
	})

	it("stays findable when the envelope nests one level deeper", () => {
		const wrapped = z.object({ data: envelope() })
		const json = z.toJSONSchema(wrapped) as Record<string, unknown>
		expect(depthOfKey(json, COMB_META_KEY)).toBe(3)
		expect(searchSchemaKey(json, COMB_META_KEY).found).toBe(true)
	})

	it("is reported ambiguous when two different entities sit at the same depth", () => {
		/* honey errors rather than picking one — worth pinning, because a
		   multi-entity response is a shape an app could plausibly write. */
		const other = z.object({ id: z.string() }).meta({
			[COMB_META_KEY]: { ...EXPECTED_ENTITY, name: "author" },
		})
		const json = z.toJSONSchema(
			z.object({ articles: z.array(generated.articleDtoReadSchema), authors: z.array(other) }),
		) as Record<string, unknown>

		const hit = searchSchemaKey(json, COMB_META_KEY)
		expect(hit.found).toBe("ambiguous")
	})

	it("is not ambiguous when the same entity appears twice — identical values dedupe", () => {
		const json = z.toJSONSchema(
			z.object({
				articles: z.array(generated.articleDtoReadSchema),
				featured: z.array(generated.articleDtoReadSchema),
			}),
		) as Record<string, unknown>

		expect(searchSchemaKey(json, COMB_META_KEY)).toEqual({ found: true, value: EXPECTED_ENTITY })
	})
})

describe("query stamp — search parameters", () => {
	const listQuery = createListQuerySchema({
		fields: { scalars: ["id", "title", "created_at"] },
		filter: { created_at: "date", title: "string" },
		pagination: { defaultLimit: 20, maxLimit: 100 },
		sort: ["created_at", "title"],
	})

	const EXPECTED_QUERY = {
		defaultOrder: "created_at.desc",
		filterable: ["created_at", "title"],
		grammar: "postgrest",
		kind: "query",
		maxLimit: 100,
		searchable: null,
		selectable: ["id", "title", "created_at"],
		sortable: ["created_at", "title"],
		stableTiebreak: "id",
		v: 1,
	}

	it("lands on the JSON Schema root, verbatim, in the input view honey reads", () => {
		const json = z.toJSONSchema(listQuery, { io: "input", unrepresentable: "any" }) as Record<string, unknown>
		expect(json[COMB_META_KEY]).toEqual(EXPECTED_QUERY)
	})

	it("is found by honey's root search at depth 0", () => {
		const json = z.toJSONSchema(listQuery, { io: "input", unrepresentable: "any" }) as Record<string, unknown>
		expect(readRootKey(json, COMB_META_KEY)).toEqual({ found: true, value: EXPECTED_QUERY })
		expect(depthOfKey(json, COMB_META_KEY)).toBe(0)
	})

	it("keeps searchable null rather than an empty list, so a consumer can omit the key", () => {
		const json = z.toJSONSchema(listQuery, { io: "input", unrepresentable: "any" }) as Record<string, unknown>
		expect(readCombQueryMeta(json)?.searchable).toBeNull()
	})
})

describe("both descriptors on one operation", () => {
	/*
	 * The entity descriptor rides the output schema; the query descriptor rides
	 * the search schema. Both use the one reserved key, by design.
	 *
	 * honey resolves a schema entry by walking `from` and stopping at the FIRST
	 * source that carries the key (codegen.ts / meta-spec.ts:443-450 at cd7eb5c).
	 * With the default source order — output, input.json, input.search, … — the
	 * entity descriptor wins and the query descriptor is never read.
	 *
	 * These tests pin comb's half: both stamps are present and correct on their
	 * own schemas. The dropping happens entirely inside honey's resolution, so
	 * the fix belongs there; comb's single-key layout is not the problem and
	 * splitting it would trade one silent drop for a permanent extra key.
	 */
	const listQuery = createListQuerySchema({
		fields: { scalars: ["id", "title"] },
		filter: { title: "string" },
		sort: ["created_at"],
	})

	it("each schema carries its own descriptor, of the right kind", () => {
		const outputJson = z.toJSONSchema(generated.articleDtoReadSchema) as Record<string, unknown>
		const searchJson = z.toJSONSchema(listQuery, { io: "input", unrepresentable: "any" }) as Record<string, unknown>

		expect(readCombEntityMeta(outputJson)?.kind).toBe("entity")
		expect(readCombQueryMeta(outputJson)).toBeNull()

		expect(readCombQueryMeta(searchJson)?.kind).toBe("query")
		expect(readCombEntityMeta(searchJson)).toBeNull()
	})

	it("a consumer reading only the first source that carries the key loses one of them", () => {
		/* Reproduction of the collision, so the honey fix has a concrete case. */
		const sources: Array<[string, Record<string, unknown>]> = [
			["output", z.toJSONSchema(generated.articleDtoReadSchema) as Record<string, unknown>],
			["input.search", z.toJSONSchema(listQuery, { io: "input", unrepresentable: "any" }) as Record<string, unknown>],
		]

		const firstHit = sources.find(([, json]) => searchSchemaKey(json, COMB_META_KEY).found !== false)
		expect(firstHit?.[0]).toBe("output")

		/* Both are individually resolvable — nothing is wrong with the stamps. */
		for (const [, json] of sources) {
			expect(searchSchemaKey(json, COMB_META_KEY).found).toBe(true)
		}
	})
})
