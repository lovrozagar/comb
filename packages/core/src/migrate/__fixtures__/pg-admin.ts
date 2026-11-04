/** A postgres.js stand-in for a replay's admin connection, and a Postgres error with its SQLSTATE */
import type { Sql } from "../core/pg-replay-database.ts"

/** A Postgres error carrying SQLSTATE `code` */
export const coded = (code: string, message = code): Error => Object.assign(new Error(message), { code })

/** A postgres.js stand-in: each query it was sent, answering each with `answer`'s rows or error */
export function fake(answer: (query: string) => Array<Record<string, unknown>> | Error = () => []): {
	sent: string[]
	sql: Sql
} {
	const sent: string[] = []
	return {
		sent,
		sql: {
			end: async () => undefined,
			unsafe: async (query: string) => {
				sent.push(query)
				const rows = answer(query)
				if (rows instanceof Error) throw rows
				return rows
			},
		},
	}
}
