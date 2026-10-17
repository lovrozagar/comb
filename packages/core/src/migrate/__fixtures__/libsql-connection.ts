/** A migrate `Connection` over a fresh in-memory libsql database, so migration code runs as SQL. */
import { type Client, createClient, type InArgs } from "@libsql/client"
import type { Connection } from "../types.ts"

export type LibsqlConnection = Connection & { client: Client; close(): Promise<void> }

export function libsqlConnection(): LibsqlConnection {
	const client = createClient({ url: ":memory:" })
	return {
		batch: async (statements) => {
			await client.batch(statements.map(({ params, sql }) => ({ args: (params ?? []) as InArgs, sql })))
		},
		client,
		close: async () => client.close(),
		dialect: "sqlite",
		execute: async (sql, params) => {
			const result = await client.execute({ args: (params ?? []) as InArgs, sql })
			return {
				columns: result.columns,
				rows: result.rows.map((row) => Array.from({ length: row.length }, (_, i) => row[i])),
			}
		},
	}
}
