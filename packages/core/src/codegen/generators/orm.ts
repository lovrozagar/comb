/**
 * ORM Client Generator
 *
 * Generates type-safe drizzle ORM client factories based on dialect and driver config
 */
import path from "node:path"
import { writeGenFile } from "../utils/fs.ts"
import { extractDbName, getTablesImportPath } from "../utils/ts-morph.ts"

type OrmDialect = "sqlite" | "postgres"
type SqliteDriver = "d1" | "turso" | "libsql" | "bun-sqlite" | "better-sqlite3"
type PostgresDriver = "neon" | "node-postgres" | "postgres-js"

type OrmConfig = {
	dialect: OrmDialect
	driver: SqliteDriver | PostgresDriver
	filePrefix?: string | undefined
	output: string
	relationsOutput?: string
}

function generateTursoOrm(dbName: string, tablesImport: string, relationsImport: string): string {
	const pascalName = dbName.charAt(0).toUpperCase() + dbName.slice(1)
	const schemaImport = `${dbName}DbSchema`
	const lines: string[] = []

	lines.push(`import type { Client as HttpClient } from "@libsql/client/http"`)
	lines.push(`import { drizzle as drizzleHttp } from "drizzle-orm/libsql/http"`)
	lines.push(`import { drizzle as drizzleWeb } from "drizzle-orm/libsql/web"`)
	lines.push(`import { relations } from "${relationsImport}"`)
	lines.push(`import * as ${schemaImport} from "${tablesImport}"`)
	lines.push("")
	lines.push(`const $clientType = () => drizzleWeb({ connection: { url: "" }, relations, schema: ${schemaImport} })`)
	lines.push("")
	lines.push(`const ${dbName}DbIsolateCache = new Map<string, ReturnType<typeof $clientType>>()`)
	lines.push("")
	lines.push(`function create${pascalName}Db(options: { authToken: string; transport?: HttpClient; url: string }) {`)
	lines.push("	const cacheKey = options.transport ? `do:${options.url}` : `http:${options.url}:${options.authToken}`")
	lines.push(`	const cached = ${dbName}DbIsolateCache.get(cacheKey)`)
	lines.push("	if (cached) return cached")
	lines.push("")
	lines.push("	const client = options.transport")
	lines.push(`		? drizzleHttp({ client: options.transport, relations, schema: ${schemaImport} })`)
	lines.push(
		`		: drizzleHttp({ connection: { authToken: options.authToken, url: options.url }, relations, schema: ${schemaImport} })`,
	)
	lines.push("")
	lines.push(`	${dbName}DbIsolateCache.set(cacheKey, client)`)
	lines.push("	return client")
	lines.push("}")
	lines.push("")
	lines.push(`function create${pascalName}DbHttp(url: string, authToken: string) {`)
	lines.push(`	return create${pascalName}Db({ authToken, url })`)
	lines.push("}")
	lines.push("")
	lines.push(`function create${pascalName}DbWeb(url: string, authToken: string) {`)
	lines.push("	const cacheKey = `web:${url}:${authToken}`")
	lines.push(`	const cached = ${dbName}DbIsolateCache.get(cacheKey)`)
	lines.push("	if (cached) return cached")
	lines.push("")
	lines.push("	const client = drizzleWeb({")
	lines.push("		connection: { authToken, url },")
	lines.push("		relations,")
	lines.push(`		schema: ${schemaImport},`)
	lines.push("	})")
	lines.push("")
	lines.push(`	${dbName}DbIsolateCache.set(cacheKey, client)`)
	lines.push("	return client")
	lines.push("}")
	lines.push("")
	lines.push(`type ${pascalName}Db = ReturnType<typeof create${pascalName}Db>`)
	lines.push(`type ${pascalName}DbHttp = ReturnType<typeof create${pascalName}DbHttp>`)
	lines.push(`type ${pascalName}DbWeb = ReturnType<typeof create${pascalName}DbWeb>`)
	lines.push(`type ${pascalName}Schema = typeof ${schemaImport}`)
	lines.push("")
	lines.push("export {")
	lines.push(`	create${pascalName}Db,`)
	lines.push(`	create${pascalName}DbHttp,`)
	lines.push(`	create${pascalName}DbWeb,`)
	lines.push(`	type ${pascalName}Db,`)
	lines.push(`	type ${pascalName}DbHttp,`)
	lines.push(`	type ${pascalName}DbWeb,`)
	lines.push(`	type ${pascalName}Schema,`)
	lines.push("}")
	lines.push("")

	return lines.join("\n")
}

function generateLibsqlOrm(dbName: string, tablesImport: string, relationsImport: string): string {
	const pascalName = dbName.charAt(0).toUpperCase() + dbName.slice(1)
	const schemaImport = `${dbName}DbSchema`
	const lines: string[] = []

	lines.push(`import { createClient } from "@libsql/client"`)
	lines.push(`import { drizzle } from "drizzle-orm/libsql"`)
	lines.push(`import { relations } from "${relationsImport}"`)
	lines.push(`import * as ${schemaImport} from "${tablesImport}"`)
	lines.push("")
	lines.push(`function create${pascalName}Db(url: string) {`)
	lines.push("	const client = createClient({ url })")
	lines.push(`	return drizzle({ client, relations, schema: ${schemaImport} })`)
	lines.push("}")
	lines.push("")
	lines.push(`type ${pascalName}Db = ReturnType<typeof create${pascalName}Db>`)
	lines.push(`type ${pascalName}Schema = typeof ${schemaImport}`)
	lines.push("")
	lines.push(`export { create${pascalName}Db, type ${pascalName}Db, type ${pascalName}Schema }`)
	lines.push("")

	return lines.join("\n")
}

function generateBunSqliteOrm(dbName: string, tablesImport: string, relationsImport: string): string {
	const pascalName = dbName.charAt(0).toUpperCase() + dbName.slice(1)
	const schemaImport = `${dbName}DbSchema`
	const lines: string[] = []

	lines.push(`import { Database } from "bun:sqlite"`)
	lines.push(`import { drizzle } from "drizzle-orm/bun-sqlite"`)
	lines.push(`import { relations } from "${relationsImport}"`)
	lines.push(`import * as ${schemaImport} from "${tablesImport}"`)
	lines.push("")
	lines.push(`function create${pascalName}Db(path: string) {`)
	lines.push("	const sqlite = new Database(path)")
	lines.push(`	return drizzle({ client: sqlite, relations, schema: ${schemaImport} })`)
	lines.push("}")
	lines.push("")
	lines.push(`type ${pascalName}Db = ReturnType<typeof create${pascalName}Db>`)
	lines.push(`type ${pascalName}Schema = typeof ${schemaImport}`)
	lines.push("")
	lines.push(`export { create${pascalName}Db, type ${pascalName}Db, type ${pascalName}Schema }`)
	lines.push("")

	return lines.join("\n")
}

function generateD1Orm(dbName: string, tablesImport: string, relationsImport: string): string {
	const pascalName = dbName.charAt(0).toUpperCase() + dbName.slice(1)
	const schemaImport = `${dbName}DbSchema`
	const lines: string[] = []

	lines.push(`import type { AnyD1Database } from "drizzle-orm/d1"`)
	lines.push(`import { drizzle } from "drizzle-orm/d1"`)
	lines.push(`import { relations } from "${relationsImport}"`)
	lines.push(`import * as ${schemaImport} from "${tablesImport}"`)
	lines.push("")
	lines.push(`function create${pascalName}Db(d1: AnyD1Database) {`)
	lines.push(`	return drizzle(d1, { relations, schema: ${schemaImport} })`)
	lines.push("}")
	lines.push("")
	lines.push(`type ${pascalName}Db = ReturnType<typeof create${pascalName}Db>`)
	lines.push(`type ${pascalName}Schema = typeof ${schemaImport}`)
	lines.push("")
	lines.push(`export { create${pascalName}Db, type ${pascalName}Db, type ${pascalName}Schema }`)
	lines.push("")

	return lines.join("\n")
}

function generateNeonOrm(dbName: string, tablesImport: string, relationsImport: string): string {
	const pascalName = dbName.charAt(0).toUpperCase() + dbName.slice(1)
	const schemaImport = `${dbName}DbSchema`
	const lines: string[] = []

	lines.push(`import { neon } from "@neondatabase/serverless"`)
	lines.push(`import { drizzle as drizzleHttp } from "drizzle-orm/neon-http"`)
	lines.push(`import { Pool } from "@neondatabase/serverless"`)
	lines.push(`import { drizzle as drizzleServerless } from "drizzle-orm/neon-serverless"`)
	lines.push(`import { relations } from "${relationsImport}"`)
	lines.push(`import * as ${schemaImport} from "${tablesImport}"`)
	lines.push("")
	lines.push(`const ${dbName}DbIsolateCache = new Map<string, ReturnType<typeof create${pascalName}DbHttp>>()`)
	lines.push("")
	lines.push(`function create${pascalName}DbHttp(connectionString: string) {`)
	lines.push(`	const cached = ${dbName}DbIsolateCache.get(connectionString)`)
	lines.push("	if (cached) return cached")
	lines.push("")
	lines.push("	const sql = neon(connectionString)")
	lines.push(`	const client = drizzleHttp({ client: sql, relations, schema: ${schemaImport} })`)
	lines.push("")
	lines.push(`	${dbName}DbIsolateCache.set(connectionString, client)`)
	lines.push("	return client")
	lines.push("}")
	lines.push("")
	lines.push(`function create${pascalName}DbPool(connectionString: string) {`)
	lines.push("	const pool = new Pool({ connectionString })")
	lines.push(`	return drizzleServerless({ client: pool, relations, schema: ${schemaImport} })`)
	lines.push("}")
	lines.push("")
	lines.push(`type ${pascalName}DbHttp = ReturnType<typeof create${pascalName}DbHttp>`)
	lines.push(`type ${pascalName}DbPool = ReturnType<typeof create${pascalName}DbPool>`)
	lines.push(`type ${pascalName}Schema = typeof ${schemaImport}`)
	lines.push("")
	lines.push("export {")
	lines.push(`	create${pascalName}DbHttp,`)
	lines.push(`	create${pascalName}DbPool,`)
	lines.push(`	type ${pascalName}DbHttp,`)
	lines.push(`	type ${pascalName}DbPool,`)
	lines.push(`	type ${pascalName}Schema,`)
	lines.push("}")
	lines.push("")

	return lines.join("\n")
}

/** Generate ORM client file based on config */
export function generateOrm(tablesFilePath: string, config: OrmConfig, cwd: string): void {
	const dbName = extractDbName(tablesFilePath)
	const tablesImport = getTablesImportPath(tablesFilePath)

	let relationsImport: string
	if (config.relationsOutput) {
		relationsImport = `./${path.basename(config.relationsOutput, ".ts")}`
	} else if (config.filePrefix) {
		relationsImport = `./${config.filePrefix}.relations.gen`
	} else {
		relationsImport = tablesImport.replace(/\.tables(\.gen)?$/, ".relations.gen")
	}
	const outputPath = path.resolve(cwd, config.output)

	let content: string

	if (config.dialect === "sqlite") {
		switch (config.driver) {
			case "d1":
				content = generateD1Orm(dbName, tablesImport, relationsImport)
				break
			case "turso":
				content = generateTursoOrm(dbName, tablesImport, relationsImport)
				break
			case "libsql":
				content = generateLibsqlOrm(dbName, tablesImport, relationsImport)
				break
			case "bun-sqlite":
				content = generateBunSqliteOrm(dbName, tablesImport, relationsImport)
				break
			default:
				throw new Error(`Unsupported SQLite driver: ${config.driver}`)
		}
	} else if (config.dialect === "postgres") {
		switch (config.driver) {
			case "neon":
				content = generateNeonOrm(dbName, tablesImport, relationsImport)
				break
			default:
				throw new Error(`Unsupported Postgres driver: ${config.driver}`)
		}
	} else {
		throw new Error(`Unsupported dialect: ${config.dialect}`)
	}

	writeGenFile(outputPath, content, "comb")
	console.log(`Generated ORM client: ${outputPath}`)
}
