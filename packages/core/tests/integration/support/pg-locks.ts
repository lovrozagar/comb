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

/*
 * Each table, view and materialized view of public by its oid, and each index and TOAST table of
 * one, and each TOAST table's index, under the name of the relation it belongs to: a query of a
 * table opens every index of it, so a lock on one blocks the table as much as a lock on the table
 */
const OWNED = `WITH owner AS (
  SELECT oid, oid AS of FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm', 'f')
), part AS (
  SELECT oid, of FROM owner
  UNION ALL SELECT c.reltoastrelid, o.of FROM owner o JOIN pg_class c ON c.oid = o.oid WHERE c.reltoastrelid <> 0
)
SELECT p.oid::int8::text AS oid, p.of::int8::text AS of, c.relname FROM part p JOIN pg_class c ON c.oid = p.of
UNION ALL
SELECT x.indexrelid::int8::text, p.of::int8::text, c.relname FROM part p JOIN pg_index x ON x.indrelid = p.oid JOIN pg_class c ON c.oid = p.of`

/* each relation's name inside the transaction, its schema's in front outside public, by its oid */
const NAMES = `SELECT oid::int8::text AS oid,
  CASE WHEN relnamespace = 'public'::regnamespace THEN relname ELSE relnamespace::regnamespace::text || '.' || relname END AS name
FROM pg_class WHERE oid = ANY($1::oid[])`

/**
 * What the transaction of `file` holds blocked at its end, `setup` committed before it: each table,
 * view and materialized view of public there before the transaction, by the name it has at the
 * end, as the file names it after a rename or a move, or the name it had if the file drops it; one
 * the file makes, which no other session sees, is not read; a lock on an index or TOAST table
 * counts as one on the relation it belongs to
 */
async function heldBy(url: string, setup: readonly string[], file: string): Promise<Record<string, string>> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		for (const sql of setup) await client.query(sql)
		const before = await client.query<{ of: string; oid: string; relname: string }>(OWNED)
		await client.query("BEGIN")
		await client.query(file)
		const { rows } = await client.query<{ mode: string; oid: string }>(
			"SELECT relation::int8::text AS oid, mode::text AS mode FROM pg_locks WHERE pid = pg_backend_pid() AND relation IS NOT NULL",
		)
		const now = await client.query<{ name: string; oid: string }>(NAMES, [
			[...new Set(before.rows.map(({ of }) => of))],
		])
		await client.query("ROLLBACK")
		const current = new Map(now.rows.map(({ name, oid }) => [oid, name]))
		const named = new Map(before.rows.map(({ of, oid, relname }) => [oid, current.get(of) ?? relname]))
		const modes = new Map<string, string[]>()
		for (const { mode, oid } of rows) {
			const name = named.get(oid)
			if (name !== undefined) modes.set(name, [...(modes.get(name) ?? []), mode])
		}
		return Object.fromEntries(
			[...modes]
				.flatMap(([name, held]) => {
					const blocks = blocking(held)
					return blocks === undefined ? [] : [[name, blocks] as const]
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
