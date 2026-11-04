/**
 * C2 of r20: the manifest is a projection of what the write DTO enforces, so a reader that validates
 * with it takes what the server takes: each column's `min`, `max`, `patterns` and `maxBytes` are
 * read here against the bounds the create DTO publishes, on both dialects.
 */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { tableOf } from "../__fixtures__/runtime.ts"
import type { FieldMeta, ImportsMeta } from "../analyzer-types.ts"
import { isStorableText } from "../../storable-text.ts"
import { generateFieldSchema } from "./dtos/field-schema.ts"
import { buildManifest, type ManifestColumn } from "./manifest.ts"

/* the shared example meta a generated schema names, which says nothing of its bounds */
const META = new Proxy({}, { get: () => ({}) })

/* a schema a c.json column names, as an app exports it */
const Profile = z.object({ bio: z.string() })

/* every text kind, a declared pattern beside a kind's own, a required text, an id reference, a c.json under a byte limit and a bounded integer */
const COLUMNS: Record<string, string> = {
	bounded: 'c.text("bounded", { min: 2, max: 9, pattern: "/^a/" })',
	count: 'c.integer("count", { min: 0, max: 9 })',
	doc: 'c.json("doc", Profile, { maxBytes: 16 })',
	email: 'c.text("email", { email: true })',
	image: 'c.text("image", { imageUri: true })',
	name: 'c.text("name", { name: true })',
	owner: 'c.ref("owner_id").references(() => owner.id)',
	plain: 'c.json("plain", Profile)',
	pw: 'c.text("pw", { password: true, max: 255 })',
	pw_pattern: 'c.text("pw_pattern", { password: true, pattern: "/[0-9]/" })',
	required: 'c.text("required").notNull()',
	url: 'c.text("url", { url: true, pattern: "/\\\\.com/" })',
}

/* what one dialect has alone: a boolean SQLite stores as an integer, a Postgres array, and plain Postgres types with a rule of their own */
const ONLY: Record<"postgres" | "sqlite", Record<string, string>> = {
	postgres: { real: 'real("real")', tags: 'c.text("tags", { max: 5 }).array()', uid: 'uuid("uid")' },
	sqlite: { flag: 'integer("flag", { mode: "boolean" })' },
}

/* the plain Postgres columns whose rule is their type's, which `kind` names: none is stated, as an inet's union or a numeric's exclusive bounds fit no field */
const TYPED = new Set(["real", "uid"])

type Published = Record<string, unknown> & { allOf?: Published[]; anyOf?: Published[] }

/** What the create DTO publishes for `field`: its value's member, not the null beside it, and an array's element */
function publishedOf(field: FieldMeta, dialect: "postgres" | "sqlite"): Published {
	const imports: ImportsMeta = { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() }
	const code = generateFieldSchema({ ...field, jsonSchemaName: "Profile" }, "create", { dialect, imports }) as string
	const schema = new Function("z", "comb", "_m", "Profile", "jsonValueSchema", `return ${code}`)(
		z,
		{ isStorableText },
		META,
		Profile,
		z.json(),
	) as z.ZodType
	const document = z.toJSONSchema(z.object({ f: schema }), { io: "input", unrepresentable: "any" }) as unknown as {
		properties: { f: Published }
	}
	const property = document.properties.f
	const value = { ...property, ...property.anyOf?.find((each) => each["type"] !== "null") }
	if (value["type"] !== "array") return value
	/* an array's rules are each element's */
	const items = value["items"] as Published
	return { ...items, ...items.anyOf?.find((each) => each["type"] !== "null") }
}

/** The regexes a published schema holds, its own and each allOf member's, as their sources */
const patternsOf = (published: Published): string[] =>
	[published, ...(published.allOf ?? [])].flatMap((each) =>
		typeof each["pattern"] === "string" ? [each["pattern"]] : [],
	)

/** A manifest pattern, a regex literal, as its source */
const sourceOf = (literal: string): string => literal.slice(1, literal.lastIndexOf("/"))

/** The bounds a published schema enforces, as a manifest column states them */
function enforced(published: Published): Pick<ManifestColumn, "max" | "maxBytes" | "min"> & { patterns: string[] } {
	const bound = (key: string) => (typeof published[key] === "number" ? (published[key] as number) : null)
	const number = published["type"] === "integer" || published["type"] === "number"
	return {
		max: bound(number ? "maximum" : "maxLength"),
		maxBytes: bound("x-comb-maxBytes"),
		min: bound(number ? "minimum" : "minLength"),
		/* an email's own check is its format, which textKind names */
		patterns: published["format"] === "email" ? [] : patternsOf(published),
	}
}

describe("the manifest states what the DTO enforces (C2 of r20)", () => {
	it.each(["sqlite", "postgres"] as const)(
		"on %s, each column's bounds and patterns as the create DTO's",
		(dialect) => {
			const table = tableOf("kinds", { ...COLUMNS, ...ONLY[dialect] }, { dialect, scope: { Profile } })
			const [entity] = buildManifest([table], "test", dialect).entities
			const stated = Object.fromEntries(
				(entity?.columns ?? []).map((column) => [
					column.name,
					{ max: column.max, maxBytes: column.maxBytes, min: column.min, patterns: column.patterns.map(sourceOf) },
				]),
			)
			/* an id's length is its pattern's, {1,48}, which the DTO publishes without a minLength or maxLength */
			const { owner: id, ...rest } = stated
			const published = Object.fromEntries(
				table.fields
					.filter((field) => field.name !== "owner" && !TYPED.has(field.name))
					.map((field) => [field.name, enforced(publishedOf(field, dialect))]),
			)
			const of = (typed: boolean) =>
				Object.fromEntries(Object.entries(rest).filter(([name]) => TYPED.has(name) === typed))
			expect(of(false)).toEqual(published)
			const none = { max: null, maxBytes: null, min: null, patterns: [] }
			expect(of(true)).toEqual(dialect === "postgres" ? { real: none, uid: none } : {})
			expect(id).toEqual({
				max: 48,
				maxBytes: null,
				min: 1,
				patterns: [String.raw`^[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]{1,48}$`],
			})
			/* the cases the review named, stated outright */
			/* a password column holds the hash: its declared bounds and pattern, none of comb's own (C1 of r21) */
			expect(stated["pw"]).toEqual({ max: 255, maxBytes: null, min: null, patterns: [] })
			expect(stated["pw_pattern"]).toEqual({ max: null, maxBytes: null, min: null, patterns: ["[0-9]"] })
			expect([stated["email"]?.min, stated["required"]?.min, stated["doc"]?.maxBytes]).toEqual([6, 1, 16])
		},
	)
})

/*
 * CD8 of r22b: a bound declared past a JS number's exact range is clamped to it, as the column
 * holds no other integer, so the manifest, the generated chain and the published schema all state
 * ±(2^53 − 1) where 0.20 stated the declared ±1e20 beside a DTO that, through `.int()`, enforced the range
 */
describe("a bound past a JS number's exact range is clamped to it (CD8 of r22b; siblings: int4, a timestamp)", () => {
	const PAST: Record<string, string> = {
		at: 'c.timestamp("at", { max: 1e20 }).notNull()',
		before: 'c.timestamp("before", { min: -1e20 }).notNull()',
	}
	const ONLY_SQLITE: Record<string, string> = {
		big: 'c.integer("big", { max: 1e20 }).notNull()',
		neg: 'c.integer("neg", { min: -1e20 }).notNull()',
	}
	const SAFE = { max: Number.MAX_SAFE_INTEGER, min: Number.MIN_SAFE_INTEGER }

	/* Postgres holds c.timestamp in a bigint and c.integer in int4, which clamps it already */
	it.each(["sqlite", "postgres"] as const)("on %s, in the manifest, the chain and the published schema", (dialect) => {
		const columns = dialect === "sqlite" ? { ...PAST, ...ONLY_SQLITE } : PAST
		const table = tableOf("past", columns, { dialect })
		const [entity] = buildManifest([table], "test", dialect).entities
		for (const name of Object.keys(columns)) {
			const field = table.fields.find((each) => each.name === name) as FieldMeta
			const column = entity?.columns.find((each) => each.name === name)
			expect({ max: column?.max, min: column?.min }, `${name} in the manifest`).toEqual(SAFE)
			const imports: ImportsMeta = { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() }
			expect(generateFieldSchema(field, "create", { dialect, imports }), `${name}'s chain`).toContain(
				".min(globalThis.Number.MIN_SAFE_INTEGER).max(globalThis.Number.MAX_SAFE_INTEGER)",
			)
			const published = publishedOf(field, dialect)
			expect({ max: published["maximum"], min: published["minimum"] }, `${name} published`).toEqual(SAFE)
		}
	})
})
