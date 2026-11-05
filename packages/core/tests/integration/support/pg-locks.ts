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

/** "a", "a and b", "a, b and c" */
const listed = (names: readonly string[]): string =>
	names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) as string}`

/**
 * comb's warning of `validate`, a VALIDATE of a constraint on `table`, when its file holds `held`, as
 * Postgres reports it; none when it holds nothing
 */
function warningOf(
	{ table, validate }: { table: string; validate: string },
	held: Readonly<Record<string, string>>,
): string[] {
	const names = Object.keys(held).toSorted()
	if (names.length === 0) return []
	const by = (blocks: string) => names.filter((name) => held[name] === blocks)
	const [reads, writes] = [by("reads and writes"), by("writes")]
	const holding =
		names.length === 1 && names[0] === table
			? `it locked against ${held[table] as string}`
			: [
					...(reads.length > 0 ? [`${listed(reads)} locked against reads and writes`] : []),
					...(writes.length > 0 ? [`${listed(writes)}${reads.length > 0 ? "" : " locked"} against writes`] : []),
				].join(", and ")
	return [
		`${validate.slice(0, -1)} (scans ${table} while this file holds ${holding}; those locks last to the file's COMMIT; validate in a later file)`,
	]
}

export { heldBy, warningOf }
