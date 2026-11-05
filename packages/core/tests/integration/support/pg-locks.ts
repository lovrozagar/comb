/**
 * The locks a Postgres transaction holds, read from pg_locks, for the lock oracles that hold comb's
 * lock warnings to Postgres's own (PA8, PA9, PA10 of r22b and their sibling 0005).
 */
import pg from "pg"

/** What a Postgres lock mode blocks of other sessions' reads and writes */
function blocking(modes: readonly string[]): string | undefined {
	if (modes.includes("AccessExclusiveLock")) return "reads and writes"
	const writes = ["ShareLock", "ShareRowExclusiveLock", "ExclusiveLock"]
	return modes.some((mode) => writes.includes(mode)) ? "writes" : undefined
}

/**
 * What the transaction of `file` holds blocked at its end, `setup` committed before it: each table,
 * view and materialized view of public there before the transaction, by the name it had then, so a
 * relation the file drops or renames is still read, and one it makes, which no other session sees, is not
 */
async function heldBy(url: string, setup: readonly string[], file: string): Promise<Record<string, string>> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		for (const sql of setup) await client.query(sql)
		const before = await client.query<{ oid: string; relname: string }>(
			"SELECT oid::int8::text AS oid, relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm', 'f')",
		)
		const named = new Map(before.rows.map(({ oid, relname }) => [oid, relname]))
		await client.query("BEGIN")
		await client.query(file)
		const { rows } = await client.query<{ modes: string[]; oid: string }>(
			"SELECT relation::int8::text AS oid, array_agg(mode::text) AS modes FROM pg_locks WHERE pid = pg_backend_pid() AND relation IS NOT NULL GROUP BY 1",
		)
		await client.query("ROLLBACK")
		return Object.fromEntries(
			rows
				.flatMap(({ modes, oid }) => {
					const name = named.get(oid)
					const blocks = blocking(modes)
					return name === undefined || blocks === undefined ? [] : [[name, blocks] as const]
				})
				.toSorted(([a], [b]) => a.localeCompare(b)),
		)
	} finally {
		await client.end()
	}
}

export { heldBy }
