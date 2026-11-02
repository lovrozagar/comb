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
			"packages/core/src/constraint-map.ts": 'import { analyze } from "./codegen/analyzer.ts"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/sqlite/d1/session.ts", message: ARROW("sqlite", "codegen") },
			{ file: "packages/core/src/pg/error-handler.ts", message: ARROW("pg", "cli") },
			{ file: "packages/core/src/meta.ts", message: ARROW("meta", "migrate") },
			{ file: "packages/core/src/error.ts", message: SHARED },
			{ file: "packages/core/src/constraint-map.ts", message: ARROW("constraint-map", "codegen") },
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
			"packages/core/src/codegen/generators/dtos/generate.ts": 'import { readMeta } from "../../../meta.ts"\n',
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
				'import type { D1Database } from "@cloudflare/workers-types"\nimport type { Miniflare } from "miniflare"\nimport { sql } from "drizzle-orm"\nimport { sqliteTable } from "drizzle-orm/sqlite-core"\n',
			"packages/core/src/codegen/utils/ts-morph.ts":
				'import type { Project } from "ts-morph"\nimport pluralize from "pluralize"\n',
			"packages/core/src/migrate/drivers/sqlite.ts": 'import type { Client } from "@libsql/client/http"\n',
			"packages/core/src/migrate/types.ts": 'import { z } from "zod"\nimport { x } from "vitest"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/sqlite/d1/session.ts", message: UNDECLARED("miniflare") },
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

/* K5 of r20: Node reads an import specifier as a URL, so a bare path with `%20` or `#` loads another file */
const BARE_PATH =
	"import() takes a URL or a package name: Node reads a bare path as a URL (%20 decodes, # starts a fragment), so pass pathToFileURL(path).href"

describe("comb/boundaries: import() takes a URL or a package name", () => {
	it("refuses a path, however it reaches import()", () => {
		const fixture = {
			"packages/core/src/migrate/a.ts":
				'import { resolve } from "node:path"\nconst file = resolve("x.ts")\nexport const a = () => import(file)\n',
			"packages/core/src/migrate/b.ts":
				'import { resolve } from "node:path"\nexport const b = () => import(resolve("x.ts"))\n',
			"packages/core/src/migrate/c.ts": "export const c = (path: string) => import(path)\n",
			"packages/core/src/migrate/d.ts": "export const d = (dir: string) => import(`${dir}/x.ts`)\n",
			"packages/core/src/migrate/e.ts": 'import { SPEC } from "./spec.ts"\nexport const e = () => import(SPEC)\n',
			"packages/core/src/migrate/f.ts": 'export const f = (url: URL) => import(url["href"])\n',
			"packages/core/src/migrate/g.ts": "const a = b\nconst b = a\nexport const g = () => import(a)\n",
			"packages/core/src/migrate/h.ts": "// @ts-expect-error a number\nexport const h = () => import(1)\n",
		}
		expect(reportsOf(rule, fixture)).toEqual(
			["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => ({
				file: `packages/core/src/migrate/${name}.ts`,
				message: BARE_PATH,
			})),
		)
	})

	it("takes a literal, a URL's href, and a name or default bound to one", () => {
		const fixture = {
			"packages/core/src/migrate/a.ts": [
				'import { pathToFileURL } from "node:url"',
				'const PEER = "drizzle-orm"',
				"export const a = (file: string) => import(pathToFileURL(file).href)",
				"export const b = (url: URL) => import(url.href)",
				"export const c = (file: string, at: number) => import(`${pathToFileURL(file).href}?mtime=${at}`)",
				"export const d = (specifier: string = PEER) => import(specifier)",
				"export async function e() {\n\tconst specifier: string = PEER\n\treturn import(specifier)\n}",
				'export const f = () => import("./b.ts")',
				"export const g = () => import(`drizzle-orm`)",
				'const NAME = "zod"',
				"export const h = () => import(NAME as string)",
				"export const i = () => import(NAME!)",
				"export const j = () => import(NAME satisfies string)",
			].join("\n"),
			"packages/core/src/migrate/b.ts": "export {}\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})
})

/* K7 of r20 */
describe("comb/boundaries: optional peers", () => {
	const PEER =
		"an optional peer loads through optionalPeer(name, why, () => import(…)) from src/migrate/core/optional-peer.ts, so a project without it is told the package, its range and the install"

	it("loads an optional peer only inside the load optionalPeer is handed", () => {
		const fixture = {
			"packages/core/src/migrate/a.ts": [
				'import { optionalPeer } from "./core/optional-peer.ts"',
				'const LIBSQL: string = "@libsql/client"',
				'export const a = () => optionalPeer("postgres", "read", () => import("postgres"))',
				'export const b = () => optionalPeer("@libsql/client", "open", async () => await import(LIBSQL))',
				'export const c = () => import("postgres")',
				"export const d = () => import(LIBSQL)",
				'export const e = () => wrap(() => import("libpg-query"))',
				'export const f = () => import("drizzle-orm")',
			].join("\n"),
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/migrate/a.ts", message: PEER },
			{ file: "packages/core/src/migrate/a.ts", message: PEER },
			{ file: "packages/core/src/migrate/a.ts", message: PEER },
		])
	})

	it("refuses a value import of an optional peer outside the modules that load after it resolved", () => {
		const fixture = {
			"packages/core/src/migrate/a.ts": [
				'import postgres from "postgres"',
				'import type { Sql } from "postgres"',
				'import { type Project } from "ts-morph"',
				'export { createClient } from "@libsql/client"',
				'export * from "libpg-query"',
				'import { sql } from "drizzle-orm"',
			].join("\n"),
			"packages/core/src/codegen/runtime/module-graph.ts": 'import { Project } from "ts-morph"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/migrate/a.ts", message: PEER },
			{ file: "packages/core/src/migrate/a.ts", message: PEER },
			{ file: "packages/core/src/migrate/a.ts", message: PEER },
		])
	})
})
