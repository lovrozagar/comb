import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { CombEntityMetaInput } from "../../../src/meta.ts"
import {
	carryCombMeta,
	COMB_META_KEY,
	COMB_META_VERSION,
	combMeta,
	readCombEntityMeta,
	readCombMeta,
	readCombQueryMeta,
} from "../../../src/meta.ts"

const entityInput: CombEntityMetaInput = {
	generated: ["id", "created_at"],
	identity: "id",
	immutable: ["id"],
	kind: "entity",
	name: "post",
	softDelete: "deleted_at",
	states: null,
	tenantColumn: null,
	uniqueIndexes: [],
}

describe("combMeta", () => {
	it("stamps the current contract version so callers never write it", () => {
		const stamp = combMeta({ ...entityInput })
		expect(stamp[COMB_META_KEY].v).toBe(COMB_META_VERSION)
	})

	it("nests everything under one reserved key", () => {
		expect(Object.keys(combMeta({ ...entityInput }))).toEqual([COMB_META_KEY])
	})
})

describe("stamped meta survives z.toJSONSchema", () => {
	const schema = z.object({ id: z.string(), title: z.string() }).meta(combMeta({ ...entityInput }))

	it("lands on the JSON Schema root, in both io views", () => {
		for (const io of ["input", "output"] as const) {
			const json = z.toJSONSchema(schema, { io })
			expect(readCombEntityMeta(json)?.name).toBe("post")
		}
	})

	it("lands inside items when the schema is wrapped in an array", () => {
		const json = z.toJSONSchema(z.array(schema)) as unknown as { items?: unknown }
		/* The reader is root-only on purpose — unwrapping has one owner, the
		   consumer that already resolved which schema to read. */
		expect(readCombEntityMeta(json)).toBeNull()
		expect(readCombEntityMeta(json.items)?.name).toBe("post")
	})

	it("survives an optional wrapper", () => {
		const json = z.toJSONSchema(z.object({ post: schema.optional() })) as unknown as {
			properties: { post: unknown }
		}
		expect(readCombEntityMeta(json.properties.post)?.name).toBe("post")
	})
})

describe("collision rules", () => {
	const base = z.object({ id: z.string() }).meta(combMeta({ ...entityInput }))

	it("merges with a user's own .meta() rather than replacing it", () => {
		const json = z.toJSONSchema(base.meta({ description: "mine" })) as Record<string, unknown>
		expect(json["description"]).toBe("mine")
		expect(readCombEntityMeta(json)?.name).toBe("post")
	})

	it("leaves the original schema untouched — .meta() clones", () => {
		base.meta({ description: "mine" })
		const json = z.toJSONSchema(base) as Record<string, unknown>
		expect(json["description"]).toBeUndefined()
		expect(readCombEntityMeta(json)?.name).toBe("post")
	})

	it("lets a user deliberately overwrite the reserved key, and refuses the result if malformed", () => {
		const clobbered = base.meta({ [COMB_META_KEY]: { nonsense: true } })
		const messages: string[] = []
		expect(readCombMeta(z.toJSONSchema(clobbered), { onDiagnostic: (m) => messages.push(m) })).toBeNull()
		expect(messages[0]).toContain("no valid integer")
	})

	it("carryCombMeta recovers facts that .extend() silently dropped", () => {
		const extended = base.extend({ extra: z.string() })
		expect(readCombEntityMeta(z.toJSONSchema(extended))).toBeNull()

		const restored = carryCombMeta(z.toJSONSchema(base), extended)
		expect(restored).not.toBeNull()
		expect(readCombEntityMeta(z.toJSONSchema(restored!))?.name).toBe("post")
	})
})

describe("versioning", () => {
	it("refuses a payload newer than the reader, rather than guessing", () => {
		const messages: string[] = []
		const future = { [COMB_META_KEY]: { ...entityInput, v: COMB_META_VERSION + 1 } }

		expect(readCombMeta(future, { onDiagnostic: (m) => messages.push(m) })).toBeNull()
		expect(messages[0]).toContain("refusing to guess")
	})

	it("accepts a payload at or below the reader's version", () => {
		expect(readCombMeta({ [COMB_META_KEY]: { ...entityInput, v: COMB_META_VERSION } })).not.toBeNull()
	})

	it("ignores unknown fields, so an additive producer change needs no reader change", () => {
		const withExtras = {
			[COMB_META_KEY]: { ...entityInput, futureField: ["anything"], v: COMB_META_VERSION },
		}
		const meta = readCombEntityMeta(withExtras)
		expect(meta?.name).toBe("post")
		expect(meta).not.toHaveProperty("futureField")
	})

	it("distinguishes 'known to be nothing' from 'not said' on softDelete", () => {
		const hard = readCombEntityMeta({ [COMB_META_KEY]: { ...entityInput, softDelete: null, v: 1 } })
		expect(hard?.softDelete).toBeNull()
	})

	it("treats a missing states field as null — it arrived after v1 shipped", () => {
		const { states: _dropped, ...legacy } = entityInput
		const meta = readCombEntityMeta({ [COMB_META_KEY]: { ...legacy, v: 1 } })
		expect(meta?.states).toBeNull()
	})

	it("reads a well-formed states payload and drops transitions", () => {
		const meta = readCombEntityMeta({
			[COMB_META_KEY]: {
				...entityInput,
				states: {
					column: "status",
					initial: "queued",
					terminal: ["sent"],
					transitions: { queued: ["sent"] },
					values: ["queued", "sent"],
				},
				v: 1,
			},
		})
		expect(meta?.states).toEqual({
			column: "status",
			initial: "queued",
			terminal: ["sent"],
			values: ["queued", "sent"],
		})
		expect(meta?.states).not.toHaveProperty("transitions")
	})

	it("refuses a malformed states payload rather than guessing", () => {
		const messages: string[] = []
		expect(
			readCombMeta(
				{ [COMB_META_KEY]: { ...entityInput, states: { column: 1 }, v: 1 } },
				{ onDiagnostic: (m) => messages.push(m) },
			),
		).toBeNull()
		expect(messages.join(" ")).toContain("malformed `states`")
	})

	it("treats a missing uniqueIndexes field as [] — it arrived after v1 shipped", () => {
		const { uniqueIndexes: _dropped, ...legacy } = entityInput
		const meta = readCombEntityMeta({ [COMB_META_KEY]: { ...legacy, v: 1 } })
		expect(meta?.uniqueIndexes).toEqual([])
	})

	it("reads a well-formed uniqueIndexes payload and drops unknown keys on each index", () => {
		const uniqueIndexes = [
			{ columns: ["email"], name: "idx_user_email" },
			{ columns: ["org_id", "slug"], extra: true, name: "idx_user_org_slug" },
		]
		const meta = readCombEntityMeta({
			[COMB_META_KEY]: { ...entityInput, uniqueIndexes, v: 1 },
		})
		expect(meta?.uniqueIndexes).toEqual([
			{ columns: ["email"], name: "idx_user_email" },
			{ columns: ["org_id", "slug"], name: "idx_user_org_slug" },
		])
		expect(meta?.uniqueIndexes[1]).not.toHaveProperty("extra")
	})

	it("refuses a malformed uniqueIndexes payload rather than guessing", () => {
		const cases: Array<[string, unknown]> = [
			["null", null],
			["a non-array", "nope"],
			["empty columns", [{ columns: [], name: "idx" }]],
			["non-string name", [{ columns: ["email"], name: 1 }]],
			["a non-object item", ["nope"]],
		]
		for (const [label, uniqueIndexes] of cases) {
			const messages: string[] = []
			expect(
				readCombMeta(
					{ [COMB_META_KEY]: { ...entityInput, uniqueIndexes, v: 1 } },
					{ onDiagnostic: (m) => messages.push(m) },
				),
				label,
			).toBeNull()
			expect(messages.join(" "), label).toContain("malformed `uniqueIndexes`")
		}
	})
})

describe("uniqueIndexes round-trip through JSON Schema", () => {
	it("preserves names, column order, and index order for two indexes", () => {
		const uniqueIndexes = [
			{ columns: ["email"], name: "idx_user_email" },
			{ columns: ["org_id", "slug"], name: "idx_user_org_slug" },
		]
		const schema = z.object({ id: z.string() }).meta(combMeta({ ...entityInput, uniqueIndexes }))
		expect(readCombEntityMeta(z.toJSONSchema(schema))?.uniqueIndexes).toEqual(uniqueIndexes)
	})

	it("reads zero indexes as []", () => {
		const schema = z.object({ id: z.string() }).meta(combMeta({ ...entityInput, uniqueIndexes: [] }))
		expect(readCombEntityMeta(z.toJSONSchema(schema))?.uniqueIndexes).toEqual([])
	})
})

describe("reader rejects malformed payloads loudly", () => {
	const cases: Array<[string, unknown, string]> = [
		["a non-object payload", "nope", "not an object"],
		["a missing version", { kind: "entity" }, "no valid integer"],
		["an unknown kind", { kind: "table", v: 1 }, "unknown kind"],
		["an entity without identity", { kind: "entity", name: "p", v: 1 }, "`name` and `identity`"],
		[
			"an entity with a non-array generated",
			{ generated: "id", identity: "id", immutable: [], kind: "entity", name: "p", v: 1 },
			"`generated` and `immutable`",
		],
		[
			"a query with a zero maxLimit",
			{
				defaultOrder: "a.desc",
				filterable: [],
				grammar: "postgrest",
				kind: "query",
				maxLimit: 0,
				searchable: null,
				selectable: [],
				sortable: [],
				stableTiebreak: "id",
				v: 1,
			},
			"positive integer `maxLimit`",
		],
	]

	for (const [label, payload, expected] of cases) {
		it(`refuses ${label}`, () => {
			const messages: string[] = []
			expect(readCombMeta({ [COMB_META_KEY]: payload }, { onDiagnostic: (m) => messages.push(m) })).toBeNull()
			expect(messages.join(" ")).toContain(expected)
		})
	}

	it("returns null without a diagnostic when the key is simply absent", () => {
		const messages: string[] = []
		expect(readCombMeta({ type: "object" }, { onDiagnostic: (m) => messages.push(m) })).toBeNull()
		expect(messages).toEqual([])
	})
})

describe("kind narrowing", () => {
	it("does not return an entity payload to a query reader, or the reverse", () => {
		const stamped = { [COMB_META_KEY]: { ...entityInput, v: 1 } }
		expect(readCombEntityMeta(stamped)).not.toBeNull()
		expect(readCombQueryMeta(stamped)).toBeNull()
	})
})
