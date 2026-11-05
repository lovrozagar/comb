/**
 * KT6 of r22b: every comb-local type a public declaration names is one a consumer can import, so
 * a helper typed around a documented API names what it takes and returns. A type comb keeps
 * internal on purpose is listed in ALLOWED with its reason; a new public signature that names a
 * local type fails here until the type is exported or the signature stops naming it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { unexportedBySubpath, unexportedIn, unexportedTypes } from "./support/public-types.ts"

const ROOT = join(import.meta.dirname, "../..")

// lookup-table: each type comb's public declarations name and keep unexported, and why
const ALLOWED: Record<string, string> = {
	"BaseConstraints (sqlite/constraints.d.ts)":
		"a fragment TextConstraints composes; a consumer names TextConstraints, as the column factories take it",
	"baseListQueryShape (query/schema-params.d.ts)":
		"the zod shape ListQueryShape is built from, named through typeof; a consumer names ListQueryShape",
	"CreatedAtName (pg/columns.d.ts)":
		"the timestamp names PgColumns' createdAt takes, which a consumer writes as literals",
	"CreatedAtName (sqlite/columns.d.ts)":
		"the timestamp names SqliteColumns' createdAt takes, which a consumer writes as literals",
	"DeletedAtName (pg/columns.d.ts)":
		"the timestamp names PgColumns' deletedAt takes, which a consumer writes as literals",
	"DeletedAtName (sqlite/columns.d.ts)":
		"the timestamp names SqliteColumns' deletedAt takes, which a consumer writes as literals",
	"NumericRangeConstraints (sqlite/constraints.d.ts)":
		"a fragment TextConstraints composes; a consumer names TextConstraints, as the column factories take it",
	"OptionalShape (query/list-schema.d.ts)": "the optional half of ListQueryShape; a consumer names ListQueryShape",
	"RESERVED_LIST_KEYS (query/schema-params.d.ts)":
		"the array ReservedListKey is read from; a consumer names the keys as ReservedListKey",
	"RESERVED_RETRIEVE_KEYS (query/schema-params.d.ts)":
		"the array ReservedRetrieveKey is read from; a consumer names the keys as ReservedRetrieveKey",
	"set (password-text.d.ts)":
		"passwordText.set, named through typeof on passwordText; a consumer calls it as passwordText.set",
	"StringTransformConstraints (sqlite/constraints.d.ts)":
		"a fragment TextConstraints composes; a consumer names TextConstraints, as the column factories take it",
	"StringValidationConstraints (sqlite/constraints.d.ts)":
		"a fragment TextConstraints composes; a consumer names TextConstraints, as the column factories take it",
	"Text (pg/columns.d.ts)": "one member's builder in PgColumns, which a consumer names whole",
	"Text (sqlite/columns.d.ts)": "one member's builder in SqliteColumns, which a consumer names whole",
	"typed (password-text.d.ts)":
		"passwordText.typed, named through typeof on passwordText; a consumer calls it as passwordText.typed",
	"UpdatedAtName (pg/columns.d.ts)":
		"the timestamp names PgColumns' updatedAt takes, which a consumer writes as literals",
	"UpdatedAtName (sqlite/columns.d.ts)":
		"the timestamp names SqliteColumns' updatedAt takes, which a consumer writes as literals",
}

/** A group of types a subpath's declarations name and another subpath, `from`, exports, and why a consumer imports them there */
type Elsewhere = { from: string; names: readonly string[]; why: string }

// lookup-table: by subpath, the types its declarations name that a consumer imports from another subpath, and why
const ELSEWHERE: Record<string, readonly Elsewhere[]> = {
	".": [
		{
			from: "./meta",
			names: ["CombStatesMeta", "MetaCarrier", "ReadOptions", "UniqueIndexMeta"],
			why: "parts of the meta record carryCombMeta and readCombEntityMeta carry; ./meta is the record's subpath",
		},
		{
			from: "./codegen",
			names: ["PartialUniqueIndexMeta"],
			why: "a partial unique index's meta, which codegen derives and ./codegen exports with the rest of the analysis",
		},
	],
	"./codegen": [
		{
			from: "./meta",
			names: ["CombEntityMeta", "CombEntityMetaInput", "CombStatesMeta"],
			why: "the meta record deriveEntityMeta derives; ./meta is the record's subpath",
		},
		{
			from: "./codegen/generators",
			names: [
				"GeneratorContext",
				"ImportStyle",
				"OrmConfig",
				"OrmDialect",
				"PostgresDriver",
				"SqliteDriver",
				"generateOrm",
			],
			why: "the ORM generator's own options, which OrmConfig is read from; ./codegen/generators exports each generator with its options",
		},
	],
	"./codegen/generators": [
		{
			from: "./codegen",
			names: [
				"AnalysisResult",
				"CheckConstraintMeta",
				"CombColumnKind",
				"ExpressionIndexMeta",
				"FieldConstraintsMeta",
				"FieldMeta",
				"ForeignKeyRef",
				"FtsTableConfig",
				"ImportRef",
				"ImportsMeta",
				"PartialUniqueIndexMeta",
				"StateMachineMeta",
				"TableMeta",
				"TimestampsMeta",
				"UniqueIndexMeta",
			],
			why: "the table analysis a generator reads; ./codegen exports it with the config that produces it",
		},
	],
	"./meta": [
		{
			from: "./codegen",
			names: ["PartialUniqueIndexMeta"],
			why: "a partial unique index's meta, which codegen derives and ./codegen exports with the rest of the analysis",
		},
	],
	"./pg/columns": [
		{
			from: "./sqlite/constraints",
			names: [
				"EnumOptions",
				"EnumStates",
				"IntegerConstraints",
				"JsonConstraints",
				"TextConstraints",
				"TimestampConstraints",
			],
			why: "the options every column factory takes, Postgres's and SQLite's alike; ./sqlite/constraints is their one subpath",
		},
	],
	"./pg/error-handler": [
		{
			from: ".",
			names: ["CombError", "ConstraintMap", "ConstraintMapEntry", "StatusKey"],
			why: "the error every handler throws and the constraint map every classifier reads; the root exports them once for all",
		},
	],
	"./query/sqlite": [
		{
			from: "./query",
			names: [
				"ComputedFilterResolver",
				"ComputedSortResolver",
				"CursorId",
				"CursorRef",
				"CursorValue",
				"DecodedCursor",
				"FieldSelection",
				"FilterAST",
				"FilterCondition",
				"FilterGroup",
				"FilterOperator",
				"KeysetKind",
				"ListExtra",
				"ListPagination",
				"ParsedFields",
				"SortDirection",
				"SortField",
				"SortNulls",
			],
			why: "the parsed list query a builder takes and its pagination; ./query exports them with the schemas that parse them",
		},
	],
	"./sqlite/columns": [
		{
			from: "./sqlite/constraints",
			names: [
				"EnumOptions",
				"EnumStates",
				"IntegerConstraints",
				"JsonConstraints",
				"TextConstraints",
				"TimestampConstraints",
			],
			why: "the options every column factory takes, Postgres's and SQLite's alike; ./sqlite/constraints is their one subpath",
		},
	],
	"./sqlite/constraint-handler": [
		{
			from: ".",
			names: ["CombDatabaseErrorKey", "CombError", "ConstraintMap", "ConstraintMapEntry", "StatusKey", "combErrorKeys"],
			why: "the error every handler throws, the keys it answers with and the constraint map every classifier reads; the root exports them once for all",
		},
	],
	"./sqlite/d1/bookmark": [
		{
			from: "./sqlite/d1/session",
			names: ["D1AnswerLike", "D1SessionLike", "D1StatementLike"],
			why: "the D1 session BookmarkTracker wraps; ./sqlite/d1/session exports it with openD1Session",
		},
	],
	"./sqlite/d1/error-handler": [
		{
			from: ".",
			names: ["CombError", "ConstraintMap", "ConstraintMapEntry", "StatusKey"],
			why: "the error every handler throws and the constraint map every classifier reads; the root exports them once for all",
		},
	],
	"./sqlite/d1/sharding": [
		{
			from: "./query",
			names: [
				"CursorId",
				"CursorRef",
				"CursorValue",
				"DecodedCursor",
				"FieldSelection",
				"KeysetKind",
				"ListExtra",
				"ListPagination",
				"ListRow",
				"PaginationResponse",
				"PaginationResponseSchema",
				"ParsedFields",
				"SortDirection",
				"SortField",
				"SortNulls",
				"paginationResponseSchema",
			],
			why: "the list and page paginateMerged takes and returns; ./query exports them with paginate, which a single database's list goes to",
		},
		{
			from: "./query/sqlite",
			names: ["ListExtras", "ListQueryResult"],
			why: "the built list MergedListQueryResult extends; ./query/sqlite exports it with buildListQuery",
		},
		{
			from: "./sqlite/columns",
			names: ["SqliteColumns"],
			why: "the columns ShardMapColumns builds the shard map from; ./sqlite/columns exports them",
		},
		{
			from: "./sqlite/constraints",
			names: [
				"EnumOptions",
				"EnumStates",
				"IntegerConstraints",
				"JsonConstraints",
				"TextConstraints",
				"TimestampConstraints",
			],
			why: "the column options ShardMapColumns' columns take; ./sqlite/constraints is their one subpath",
		},
	],
}

describe("the walk", () => {
	it("finds a local type a public declaration names through a chain, and none it exports", () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-public-types-walk-"))
		try {
			writeFileSync(join(dir, "inner.d.ts"), "export type Deep = { n: number }\nexport type Inner = { deep: Deep }\n")
			writeFileSync(
				join(dir, "index.d.ts"),
				'import type { Inner } from "./inner.ts"\nexport type Shown = { n: number }\nexport declare function f(inner: Inner): Shown\n',
			)
			expect([...unexportedIn(dir, [join(dir, "index.d.ts")])]).toEqual([
				["Inner (inner.d.ts)", "f"],
				["Deep (inner.d.ts)", "Inner <- f"],
			])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

describe("comb's public declarations (KT6)", () => {
	const found = unexportedTypes(ROOT)

	it("name no local type a consumer cannot import, but the ones ALLOWED gives a reason for", () => {
		expect([...found].filter(([key]) => ALLOWED[key] === undefined).map(([key, from]) => `${key} <- ${from}`)).toEqual(
			[],
		)
	})

	it("allow only a type they still name, each with its reason", () => {
		expect(Object.keys(ALLOWED).filter((key) => !found.has(key))).toEqual([])
		expect(Object.entries(ALLOWED).filter(([, why]) => why.trim() === "")).toEqual([])
	})
})

/** Whether ELSEWHERE gives `subpath`'s `name` a subpath to import it from */
const elsewhere = (subpath: string, name: string) =>
	(ELSEWHERE[subpath] ?? []).some(({ names }) => names.includes(name))
/** A walk key's type name, without its file */
const nameOf = (key: string) => key.replace(/ \(.*\)$/, "")

/* AD4 of the area D review: README item 1 says a consumer names each type from the subpath that names it */
describe("each subpath's public declarations (AD4)", () => {
	const { exports, found } = unexportedBySubpath(ROOT)
	it("export every local type they name, but the ones ALLOWED or ELSEWHERE gives a reason for", () => {
		const missing = [...found].flatMap(([subpath, each]) =>
			[...each]
				.filter(([key]) => ALLOWED[key] === undefined && !elsewhere(subpath, nameOf(key)))
				.map(([key, from]) => `${subpath}: ${key} <- ${from}`),
		)
		expect(missing).toEqual([])
	})

	it("list in ELSEWHERE only a type the subpath still names, from a subpath that exports it, with its reason", () => {
		const stale = Object.entries(ELSEWHERE).flatMap(([subpath, groups]) =>
			groups.flatMap(({ from, names, why }) =>
				names
					.filter(
						(name) =>
							why.trim() === "" ||
							exports.get(from)?.has(name) !== true ||
							![...(found.get(subpath)?.keys() ?? [])].some((key) => nameOf(key) === name),
					)
					.map((name) => `${subpath}: ${name} from ${from}`),
			),
		)
		expect(stale).toEqual([])
	})
})
