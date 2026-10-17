import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules.boundaries
const ESCAPE = "an import stays inside packages/core/src"
const NODE_PREFIX = "import node builtins with the node: prefix"
const SHARED = "shared roots (error, types, lru, id, states) import only each other"
const UNDECLARED = (name: string) => `${name} is not in dependencies or peerDependencies of packages/core/package.json`
const ARROW = (from: string, to: string) => `${from} must not import ${to}`
const BUN =
	"Bun APIs (the Bun global, bun: modules) belong to src/migrate/core/process.ts, src/migrate/drivers/bun-sqlite.ts and src/bin.ts"

describe("comb/boundaries: feature arrows", () => {
	it("forbids the dialect and tooling arrows, statically or dynamically", () => {
		const fixture = {
			"packages/core/src/pg/columns.ts": 'import { EnumStates } from "../sqlite/constraints.ts"\n',
			"packages/core/src/sqlite/columns.ts": 'export { pgEnum } from "../pg/columns.ts"\n',
			"packages/core/src/migrate/core/apply.ts":
				'export { buildListQuery } from "../../query/sqlite/build-list-query.ts"\n',
			"packages/core/src/query/filter.ts": 'export const load = () => import("../migrate/config.ts")\n',
			"packages/core/src/query/sqlite/search.ts": 'export * from "../../codegen/utils/case.ts"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/pg/columns.ts", message: ARROW("pg", "sqlite") },
			{ file: "packages/core/src/sqlite/columns.ts", message: ARROW("sqlite", "pg") },
			{ file: "packages/core/src/migrate/core/apply.ts", message: ARROW("migrate", "query") },
			{ file: "packages/core/src/query/filter.ts", message: ARROW("query", "migrate") },
			{ file: "packages/core/src/query/sqlite/search.ts", message: ARROW("query", "codegen") },
		])
	})

	it("keeps runtime features and roots off the tooling: codegen, migrate, cli, bin", () => {
		const fixture = {
			"packages/core/src/sqlite/d1/session.ts": 'import { x } from "../../codegen/analyzer.ts"\n',
			"packages/core/src/pg/error-handler.ts": 'import { runCli } from "../cli.ts"\n',
			"packages/core/src/meta.ts": 'import { loadConfig } from "./migrate/config.ts"\n',
			"packages/core/src/error.ts": 'import { x } from "./bin.ts"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/sqlite/d1/session.ts", message: ARROW("sqlite", "codegen") },
			{ file: "packages/core/src/pg/error-handler.ts", message: ARROW("pg", "cli") },
			{ file: "packages/core/src/meta.ts", message: ARROW("meta", "migrate") },
			{ file: "packages/core/src/error.ts", message: SHARED },
		])
	})
})

describe("comb/boundaries: allowed imports", () => {
	it("exempts type-only imports and exports from the arrows", () => {
		const fixture = {
			"packages/core/src/pg/columns.ts": 'import type { EnumStates } from "../sqlite/constraints.ts"\n',
			"packages/core/src/meta.ts": 'import { type TableMeta, type FieldMeta } from "./codegen/analyzer-types.ts"\n',
			"packages/core/src/query/schema.ts": 'export type { Dialect } from "../migrate/types.ts"\n',
			"packages/core/src/types.ts": 'import type { ListQuery } from "./query/schema.ts"\n',
			"packages/core/src/sqlite/columns.ts": 'import { type A, b } from "../pg/columns.ts"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/sqlite/columns.ts", message: ARROW("sqlite", "pg") },
		])
	})

	it("allows the declared arrows and every feature reaching the shared roots", () => {
		const fixture = {
			"packages/core/src/query/sqlite/keyset.ts": 'import { effectiveNulls } from "../cursor.ts"\n',
			"packages/core/src/sqlite/d1/error-handler.ts":
				'import { handleConstraintViolation } from "../constraint-handler.ts"\nimport { CombError } from "../../error.ts"\n',
			"packages/core/src/codegen/generators/dtos.ts": 'import { readMeta } from "../../meta.ts"\n',
			"packages/core/src/codegen/utils/validate.ts": 'import { CURSOR_TIEBREAK_COLUMN } from "../../query/cursor.ts"\n',
			"packages/core/src/cli.ts": 'import { loadConfig } from "./migrate/config.ts"\n',
			"packages/core/src/sqlite/d1/sharding/router.ts":
				'import { LruCache } from "../../../lru.ts"\nimport { combErrorKeys } from "../../../types.ts"\n',
			"packages/core/src/pg/error-handler.ts":
				'import { CombError } from "../error.ts"\nimport { createId } from "../id.ts"\n',
			"packages/core/src/error.ts": 'import { combErrorKeys } from "./types.ts"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("keeps the shared roots off every feature and every import inside src", () => {
		const fixture = {
			"packages/core/src/types.ts": 'import { listQuery } from "./query/schema.ts"\n',
			"packages/core/src/lru.ts": 'export { x } from "./sqlite/patterns.ts"\n',
			"packages/core/src/query/filter.ts": 'import { x } from "../../tests/integration/support/pg.ts"\n',
			"packages/core/src/index.ts": 'export * from "./query/index.ts"\nexport * from "./sqlite/columns.ts"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/types.ts", message: SHARED },
			{ file: "packages/core/src/lru.ts", message: SHARED },
			{ file: "packages/core/src/query/filter.ts", message: ESCAPE },
		])
	})
})

describe("comb/boundaries: packages", () => {
	it("requires the node: prefix on builtins", () => {
		const fixture = {
			"packages/core/src/migrate/core/atlas.ts":
				'import { join } from "path"\nimport { readFileSync } from "fs"\nimport { writeFile } from "node:fs/promises"\n',
			"packages/core/src/migrate/drivers/d1.ts": 'export const load = () => import("fs/promises")\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/migrate/core/atlas.ts", message: NODE_PREFIX },
			{ file: "packages/core/src/migrate/core/atlas.ts", message: NODE_PREFIX },
			{ file: "packages/core/src/migrate/drivers/d1.ts", message: NODE_PREFIX },
		])
	})

	it("requires every package import, type-only included, to be a dependency or peer", () => {
		const fixture = {
			"packages/core/src/sqlite/d1/session.ts":
				'import type { D1Database } from "@cloudflare/workers-types"\nimport { sql } from "drizzle-orm"\nimport { sqliteTable } from "drizzle-orm/sqlite-core"\n',
			"packages/core/src/codegen/utils/ts-morph.ts":
				'import { Project } from "ts-morph"\nimport pluralize from "pluralize"\n',
			"packages/core/src/migrate/drivers/sqlite.ts": 'import { createClient } from "@libsql/client/http"\n',
			"packages/core/src/migrate/types.ts": 'import { z } from "zod"\nimport { x } from "vitest"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/sqlite/d1/session.ts", message: UNDECLARED("@cloudflare/workers-types") },
			{ file: "packages/core/src/migrate/types.ts", message: UNDECLARED("vitest") },
		])
	})
})

describe("comb/boundaries: Bun", () => {
	it("keeps the Bun global and bun: modules in the process module, the bun-sqlite driver and the bin shim", () => {
		const fixture = {
			"packages/core/src/migrate/drivers/d1.ts":
				'export const p = Bun.spawn(["wrangler"])\nexport const t = typeof Bun\nexport const w = () => Bun.write("a", "b")\n',
			"packages/core/src/query/x.ts": 'import { Database } from "bun:sqlite"\n',
			"packages/core/src/migrate/drivers/sqlite.ts": 'export const b = () => import("bun:sqlite")\n',
			"packages/core/src/migrate/drivers/bun-sqlite.ts":
				'import { Database } from "bun:sqlite"\nexport const v = Bun.version\n',
			"packages/core/src/migrate/core/process.ts": 'export const p = () => Bun.spawn(["x"])\n',
			"packages/core/src/bin.ts": "export const v = Bun.version\n",
			"packages/core/src/query/filter.ts": "const o = { Bun: 1 }\nexport const n = o.Bun\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/migrate/drivers/d1.ts", message: BUN },
			{ file: "packages/core/src/migrate/drivers/d1.ts", message: BUN },
			{ file: "packages/core/src/migrate/drivers/d1.ts", message: BUN },
			{ file: "packages/core/src/query/x.ts", message: BUN },
			{ file: "packages/core/src/migrate/drivers/sqlite.ts", message: BUN },
		])
	})

	it("ignores tests and files outside src", () => {
		const fixture = {
			"packages/core/src/pg/columns.test.ts":
				'import { c } from "../sqlite/columns.ts"\nimport "path"\nimport "bun:sqlite"\nBun.spawn([])\n',
			"packages/core/tests/integration/support/pg.ts": 'import pg from "pg"\nimport { join } from "path"\n',
			"packages/core/lint/boundaries.js": 'import { builtinModules } from "module"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the comb plugin entry", () => {
		const fixture = {
			"packages/core/src/pg/columns.ts": 'import { EnumStates } from "../sqlite/constraints.ts"\n',
			"packages/core/src/sqlite/columns.ts": 'import { sql } from "drizzle-orm"\n',
		}
		expect(oxlintReports("boundaries", fixture)).toEqual([
			{ file: "packages/core/src/pg/columns.ts", message: ARROW("pg", "sqlite") },
		])
	})
})
