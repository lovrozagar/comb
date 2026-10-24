/**
 * Tables built in the test's own process and read as the runtime reader reads a tables module, so
 * a unit test gets the FieldMeta and TableMeta codegen derives without a file or a child process.
 * A column may be written as source, evaluated with `c`, `sql`, `z` and drizzle's builders in scope.
 */
import { sql } from "drizzle-orm"
import * as pgCore from "drizzle-orm/pg-core"
import * as sqliteCore from "drizzle-orm/sqlite-core"
import * as z from "zod"
import { c as pgC } from "../../pg/columns.ts"
import { c as sqliteC } from "../../sqlite/columns.ts"
import type { AnalysisResult, FieldMeta, TableMeta } from "../analyzer-types.ts"
import { snapshotOf } from "../runtime/read-tables.ts"
import { toAnalysis } from "../runtime/to-meta.ts"

type Dialect = "postgres" | "sqlite"

/** Where a fixture's tables "live": its exports' module, which no file holds */
export const FIXTURE_TABLES = "/fixture/db.core.tables.ts"

/** The analysis of every table `namespace` exports, as a tables module exporting them would get */
export function analyzeNamespace(
	namespace: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): AnalysisResult {
	const loaded = [
		{ external: false, module: FIXTURE_TABLES, namespace },
		{ external: false, module: "/fixture/schemas.ts", namespace: extra },
	]
	return toAnalysis(snapshotOf(loaded), FIXTURE_TABLES)
}

/** The value `source` spells, with the column builders of `dialect`, `sql`, `z` and `scope` in scope */
export function evaluate(source: string, dialect: Dialect = "sqlite", scope: Record<string, unknown> = {}): unknown {
	const core = dialect === "postgres" ? pgCore : sqliteCore
	const names = { ...core, c: dialect === "postgres" ? pgC : sqliteC, sql, z, ...scope }
	return new Function(...Object.keys(names), `return (${source})`)(...Object.values(names))
}

type FieldOptions = { dialect?: Dialect; scope?: Record<string, unknown> }

/** The names fixture sources reference without defining: tables a key points at, and schemas a column is given */
function defaultScope(dialect: Dialect): Record<string, unknown> {
	const c = dialect === "postgres" ? pgC : sqliteC
	const define = (dialect === "postgres" ? pgCore.pgTable : sqliteCore.sqliteTable) as (
		name: string,
		columns: object,
	) => unknown
	const tables = Object.fromEntries(
		["author", "owner", "team", "tenant", "user", "x"].map((name) => [name, define(name, { id: c.id(name) })]),
	)
	return { ...tables, blobSchema: z.object({}), prefs: z.object({}), schema: z.object({}) }
}

/** The TableMeta of one table named `name`, its columns written as source by key */
export function tableOf(
	name: string,
	columns: Record<string, string>,
	{ dialect = "sqlite", scope: own = {} }: FieldOptions = {},
): TableMeta {
	const scope = { ...defaultScope(dialect), ...own }
	const built = Object.fromEntries(
		Object.entries(columns).map(([key, source]) => [key, evaluate(source, dialect, scope)]),
	)
	const define = (dialect === "postgres" ? pgCore.pgTable : sqliteCore.sqliteTable) as (
		name: string,
		columns: never,
	) => unknown
	const tables = Object.fromEntries(Object.entries(scope).filter(([, value]) => typeof value === "object"))
	const exported = { ...tables, [name]: define(name, built as never) }
	return analyzeNamespace(exported, scope).tables.find((table) => table.varName === name) as TableMeta
}

/** The FieldMeta of one column written as `source`, under the property `key` */
export function fieldOf(key: string, source: string, options: FieldOptions = {}): FieldMeta {
	return tableOf("fixture", { [key]: source }, options).fields[0] as FieldMeta
}

/** The FieldMeta of `source` under `key`: the text-reading tests' name for fieldOf */
export const parseField = (key: string, source: string, options: FieldOptions = {}): FieldMeta =>
	fieldOf(key, source, options)
