/**
 * What SQLite answers a pending file on a copy's script (8.5 of plan 21), as the D1 proof asks D1: the script in one
 * transaction with foreign keys on, as D1 runs its batch, then the file in one, then an EXPLAIN of each view, and each
 * table's writes, the file made or changed (d1-engine.ts's probes). "passes", or the first error, the probe named.
 */
import { DatabaseSync } from "node:sqlite"

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** The copy's schema, each object's SQL by type and name */
function master(db: DatabaseSync): Map<string, { sql: string; table: string; type: string }> {
	const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL").all()
	return new Map(
		rows.map((row) => [
			`${String(row["type"])} ${String(row["name"])}`,
			{ sql: String(row["sql"]), table: String(row["tbl_name"]), type: String(row["type"]) },
		]),
	)
}

/** `sql` in one transaction, rolled back when it fails */
function inTransaction(db: DatabaseSync, sql: string): void {
	db.exec("BEGIN")
	try {
		db.exec(sql)
		db.exec("COMMIT")
	} catch (error) {
		db.exec("ROLLBACK")
		throw error
	}
}

/** The EXPLAINs of what `file` made or changed since `before` */
function probes(db: DatabaseSync, before: ReturnType<typeof master>): string[] {
	const changed = [...master(db)].filter(([key, object]) => before.get(key)?.sql !== object.sql).map(([, o]) => o)
	const views = changed.filter((object) => object.type === "view").map((object) => object.table)
	const tables = new Set(
		changed.filter((object) => object.type === "table" || object.type === "trigger").map((object) => object.table),
	)
	return [
		...views.map((view) => `EXPLAIN SELECT * FROM ${quote(view)}`),
		...[...tables].flatMap((table) => {
			const columns = db
				.prepare(`PRAGMA table_xinfo(${quote(table)})`)
				.all()
				.filter((row) => row["hidden"] === 0)
				.map((row) => quote(String(row["name"])))
			return [
				`EXPLAIN INSERT INTO ${quote(table)} DEFAULT VALUES`,
				`EXPLAIN UPDATE ${quote(table)} SET ${columns.map((column) => `${column} = ${column}`).join(", ")}`,
				`EXPLAIN DELETE FROM ${quote(table)}`,
			]
		}),
	]
}

/** SQLite's answer to `file` on a copy `script` makes: "passes", "seed: …" when the script fails, or the file's error */
export function verdictOf(script: readonly string[], file: string): string {
	const db = new DatabaseSync(":memory:")
	try {
		db.exec("PRAGMA foreign_keys = ON")
		try {
			inTransaction(db, script.map((sql) => `${sql};`).join("\n"))
		} catch (error) {
			return `seed: ${(error as Error).message}`
		}
		const before = master(db)
		try {
			inTransaction(db, file)
		} catch (error) {
			return (error as Error).message
		}
		for (const probe of probes(db, before)) {
			try {
				db.exec(probe)
			} catch (error) {
				return `${probe}: ${(error as Error).message}`
			}
		}
		return "passes"
	} finally {
		db.close()
	}
}
