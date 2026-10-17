/** In-process SQLite on libsql: the engine the SQLite suites run on under vitest and Node. */
import { type Client, createClient } from "@libsql/client"
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql"

export type LibsqlHarness = {
	client: Client
	db: LibSQLDatabase
	close(): void
}

/** A fresh `:memory:` database; every call is its own database. */
export function libsqlMemory(): LibsqlHarness {
	const client = createClient({ url: ":memory:" })
	return { client, close: () => client.close(), db: drizzle({ client }) }
}

export { libsqlConnection } from "../../../src/migrate/__fixtures__/libsql-connection.ts"
