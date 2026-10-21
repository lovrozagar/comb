/**
 * ORM Client Generator
 *
 * Generates type-safe drizzle ORM client factories based on dialect and driver config
 */
import path from "node:path"
import { writeGenFile } from "../utils/fs.ts"
import { importPathFrom } from "../utils/ts-morph.ts"
import type { GeneratorContext } from "./context-types.ts"
import { dbIdentifiers } from "../utils/case.ts"

type OrmDialect = "sqlite" | "postgres"
type SqliteDriver = "bun-sqlite" | "d1" | "libsql" | "turso"
type PostgresDriver = "neon"

type OrmConfig = {
	dialect: OrmDialect
	driver: SqliteDriver | PostgresDriver
	filePrefix?: string | undefined
	output: string
	relationsOutput?: string
}

/** The names every client file is built from */
type OrmNames = { dbName: string; pascal: string; relationsImport: string; schemaImport: string; tablesImport: string }

/** The relations and schema imports every client file ends its import block with */
function schemaImports(n: OrmNames): string[] {
	return [
		`import { relations } from "${n.relationsImport}"`,
		`import type * as ${n.schemaImport} from "${n.tablesImport}"`,
	]
}

/** The type aliases and export block for the factories named `create<Pascal><kind>` */
function exportBlock(n: OrmNames, kinds: string[]): string[] {
	return [
		...kinds.map((kind) => `type ${n.pascal}${kind} = ReturnType<typeof create${n.pascal}${kind}>`),
		`type ${n.pascal}Schema = typeof ${n.schemaImport}`,
		"",
		"export {",
		...kinds.map((kind) => `	create${n.pascal}${kind},`),
		...kinds.map((kind) => `	type ${n.pascal}${kind},`),
		`	type ${n.pascal}Schema,`,
		"}",
		"",
	]
}

/** A file exporting one `create<Pascal>Db` factory: driver imports, the factory, then its types */
function singleClientFile(n: OrmNames, driverImports: string[], factory: string[]): string {
	return [
		...driverImports,
		...schemaImports(n),
		"",
		...factory,
		"",
		`type ${n.pascal}Db = ReturnType<typeof create${n.pascal}Db>`,
		`type ${n.pascal}Schema = typeof ${n.schemaImport}`,
		"",
		`export { create${n.pascal}Db, type ${n.pascal}Db, type ${n.pascal}Schema }`,
		"",
	].join("\n")
}

/** The rest of a cached factory: return the client cached under `cacheKey`, or build and cache one */
function cachedBody(n: OrmNames, cacheKey: string, build: string[]): string[] {
	return [
		`	const cached = ${n.dbName}DbIsolateCache.get(${cacheKey})`,
		"	if (cached) return cached",
		"",
		...build,
		"",
		`	${n.dbName}DbIsolateCache.set(${cacheKey}, client)`,
		"	return client",
		"}",
	]
}

function tursoFactories(n: OrmNames): string[] {
	return [
		`function create${n.pascal}Db(options: { authToken: string; transport?: HttpClient; url: string }) {`,
		"	const cacheKey = options.transport ? `do:${options.url}` : `http:${options.url}:${options.authToken}`",
		...cachedBody(n, "cacheKey", [
			"	const client = options.transport",
			`		? drizzleHttp({ client: options.transport, relations })`,
			`		: drizzleHttp({ connection: { authToken: options.authToken, url: options.url }, relations })`,
		]),
		"",
		`function create${n.pascal}DbHttp(url: string, authToken: string) {`,
		`	return create${n.pascal}Db({ authToken, url })`,
		"}",
		"",
		`function create${n.pascal}DbWeb(url: string, authToken: string) {`,
		"	const cacheKey = `web:${url}:${authToken}`",
		...cachedBody(n, "cacheKey", [
			"	const client = drizzleWeb({",
			"		connection: { authToken, url },",
			"		relations,",
			"	})",
		]),
	]
}

function generateTursoOrm(n: OrmNames): string {
	return [
		`import type { Client as HttpClient } from "@libsql/client/http"`,
		`import { drizzle as drizzleHttp } from "drizzle-orm/libsql/http"`,
		`import { drizzle as drizzleWeb } from "drizzle-orm/libsql/web"`,
		...schemaImports(n),
		"",
		`const $clientType = () => drizzleWeb({ connection: { url: "" }, relations })`,
		"",
		`const ${n.dbName}DbIsolateCache = new Map<string, ReturnType<typeof $clientType>>()`,
		"",
		...tursoFactories(n),
		"",
		...exportBlock(n, ["Db", "DbHttp", "DbWeb"]),
	].join("\n")
}

function generateLibsqlOrm(n: OrmNames): string {
	return singleClientFile(
		n,
		[`import { createClient } from "@libsql/client"`, `import { drizzle } from "drizzle-orm/libsql"`],
		[
			`function create${n.pascal}Db(url: string) {`,
			"	const client = createClient({ url })",
			`	return drizzle({ client, relations })`,
			"}",
		],
	)
}

function generateBunSqliteOrm(n: OrmNames): string {
	return singleClientFile(
		n,
		[`import { Database } from "bun:sqlite"`, `import { drizzle } from "drizzle-orm/bun-sqlite"`],
		[
			`function create${n.pascal}Db(path: string) {`,
			"	const sqlite = new Database(path)",
			`	return drizzle({ client: sqlite, relations })`,
			"}",
		],
	)
}

function generateD1Orm(n: OrmNames): string {
	return singleClientFile(
		n,
		[`import type { AnyD1Database } from "drizzle-orm/d1"`, `import { drizzle } from "drizzle-orm/d1"`],
		[`function create${n.pascal}Db(d1: AnyD1Database) {`, `	return drizzle(d1, { relations })`, "}"],
	)
}

function generateNeonOrm(n: OrmNames): string {
	return [
		`import { neon } from "@neondatabase/serverless"`,
		`import { drizzle as drizzleHttp } from "drizzle-orm/neon-http"`,
		`import { Pool } from "@neondatabase/serverless"`,
		`import { drizzle as drizzleServerless } from "drizzle-orm/neon-serverless"`,
		...schemaImports(n),
		"",
		/* the cache is typed from the driver, not from the factory that fills it, which would make its type circular (F3) */
		`const $clientType = () => drizzleHttp({ client: neon(""), relations })`,
		"",
		`const ${n.dbName}DbIsolateCache = new Map<string, ReturnType<typeof $clientType>>()`,
		"",
		`function create${n.pascal}DbHttp(connectionString: string) {`,
		...cachedBody(n, "connectionString", [
			"	const sql = neon(connectionString)",
			`	const client = drizzleHttp({ client: sql, relations })`,
		]),
		"",
		`function create${n.pascal}DbPool(connectionString: string) {`,
		"	const pool = new Pool({ connectionString })",
		`	return drizzleServerless({ client: pool, relations })`,
		"}",
		"",
		...exportBlock(n, ["DbHttp", "DbPool"]),
	].join("\n")
}

/** The renderer for a dialect and driver; an unsupported pair is refused by name */
function rendererFor({ dialect, driver }: OrmConfig): (n: OrmNames) => string {
	if (dialect === "sqlite") {
		switch (driver) {
			case "d1":
				return generateD1Orm
			case "turso":
				return generateTursoOrm
			case "libsql":
				return generateLibsqlOrm
			case "bun-sqlite":
				return generateBunSqliteOrm
			default:
				throw new Error(`Unsupported SQLite driver: ${driver}`)
		}
	}
	if (dialect === "postgres") {
		if (driver === "neon") return generateNeonOrm
		throw new Error(`Unsupported Postgres driver: ${driver}`)
	}
	throw new Error(`Unsupported dialect: ${String(dialect)}`)
}

/** Where relations come from: the configured relations file, else the prefixed name beside the client */
function relationsFileOf(config: OrmConfig, outputPath: string, dbName: string): string {
	if (config.relationsOutput) return config.relationsOutput
	return path.join(path.dirname(outputPath), `${config.filePrefix ?? `db.${dbName}`}.relations.gen.ts`)
}

/** Generate ORM client file based on config */
export function generateOrm(ctx: GeneratorContext, config: OrmConfig): void {
	const render = rendererFor(config)
	const { dbName } = ctx.analysis
	const outputPath = path.resolve(ctx.cwd, config.output)
	/* each import runs from where the client is written */
	const tablesImport = importPathFrom(outputPath, path.resolve(ctx.cwd, ctx.tablesPath))
	const names: OrmNames = {
		dbName: dbIdentifiers(dbName).camel,
		pascal: dbIdentifiers(dbName).pascal,
		relationsImport: importPathFrom(outputPath, path.resolve(ctx.cwd, relationsFileOf(config, outputPath, dbName))),
		schemaImport: `${dbIdentifiers(dbName).camel}DbSchema`,
		tablesImport,
	}
	writeGenFile(outputPath, render(names), { generator: "comb", staged: ctx.staged })
	ctx.log(`Generated ORM client: ${outputPath}`)
}
