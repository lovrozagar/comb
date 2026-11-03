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
import { unexportedIn, unexportedTypes } from "./support/public-types.ts"

const ROOT = join(import.meta.dirname, "../..")

// lookup-table: each type comb's public declarations name and keep unexported, and why
const ALLOWED: Record<string, string> = {
	"BaseConstraints (sqlite/constraints.d.ts)":
		"a fragment TextConstraints composes; a consumer names TextConstraints, as the column factories take it",
	"baseListQueryShape (query/schema-params.d.ts)":
		"the zod shape ListQueryShape is built from, named through typeof; a consumer names ListQueryShape",
	"Connect (migrate/core/pg-live-objects.d.ts)":
		"a test seam on CliIo, which KT7 of r22b (plan 21's 14.5) takes off the public type",
	"CreatedAtName (pg/columns.d.ts)":
		"the timestamp names PgColumns' createdAt takes, which a consumer writes as literals",
	"CreatedAtName (sqlite/columns.d.ts)":
		"the timestamp names SqliteColumns' createdAt takes, which a consumer writes as literals",
	"DeletedAtName (pg/columns.d.ts)":
		"the timestamp names PgColumns' deletedAt takes, which a consumer writes as literals",
	"DeletedAtName (sqlite/columns.d.ts)":
		"the timestamp names SqliteColumns' deletedAt takes, which a consumer writes as literals",
	"HistoryFile (migrate/core/pg-replay.d.ts)":
		"a test seam on CliIo, which KT7 of r22b (plan 21's 14.5) takes off the public type",
	"LiveObjects (migrate/core/pg-live-types.d.ts)":
		"a test seam on CliIo, which KT7 of r22b (plan 21's 14.5) takes off the public type",
	"LiveRead (migrate/core/pg-live-types.d.ts)":
		"a test seam on CliIo, which KT7 of r22b (plan 21's 14.5) takes off the public type",
	"LiveTarget (migrate/core/pg-live-types.d.ts)":
		"a test seam on CliIo, which KT7 of r22b (plan 21's 14.5) takes off the public type",
	"NumericRangeConstraints (sqlite/constraints.d.ts)":
		"a fragment TextConstraints composes; a consumer names TextConstraints, as the column factories take it",
	"OptionalShape (query/list-schema.d.ts)": "the optional half of ListQueryShape; a consumer names ListQueryShape",
	"replayCatalog (migrate/core/pg-replay.d.ts)":
		"a test seam on CliIo, which KT7 of r22b (plan 21's 14.5) takes off the public type",
	"RESERVED_LIST_KEYS (query/schema-params.d.ts)":
		"the array ReservedListKey is read from; a consumer names the keys as ReservedListKey",
	"RESERVED_RETRIEVE_KEYS (query/schema-params.d.ts)":
		"the array ReservedRetrieveKey is read from; a consumer names the keys as ReservedRetrieveKey",
	"set (password-text.d.ts)":
		"passwordText.set, named through typeof on passwordText; a consumer calls it as passwordText.set",
	"Sql (migrate/core/pg-live-objects.d.ts)":
		"a test seam on CliIo, which KT7 of r22b (plan 21's 14.5) takes off the public type",
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
