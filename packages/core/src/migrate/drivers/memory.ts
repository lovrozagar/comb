/**
 * A private in-memory SQLite database, for the proof run (migrate/core/proof-run.ts): bun:sqlite
 * under Bun, node:sqlite under Node. Nothing in it reaches a target database.
 */

/** What the proof run does with an in-memory database */
export type MemoryDb = {
	/** each row a statement returns, by column */
	all(sql: string, params?: readonly unknown[]): Array<Record<string, unknown>>
	close(): void
	/** run statements, several at once */
	exec(sql: string): void
	/** run one statement with parameters */
	run(sql: string, params?: readonly unknown[]): void
}

type NodeStatement = { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }

/** A new in-memory database on the runtime comb runs on */
export async function openMemory(): Promise<MemoryDb> {
	if (process.versions["bun"] !== undefined) {
		const { openBunMemory } = await import("./bun-sqlite.ts")
		return openBunMemory()
	}
	const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
		DatabaseSync: new (path: string) => { close(): void; exec(sql: string): void; prepare(sql: string): NodeStatement }
	}
	const db = new DatabaseSync(":memory:")
	return {
		all: (sql, params = []) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
		close: () => db.close(),
		exec: (sql) => db.exec(sql),
		run: (sql, params = []) => void db.prepare(sql).run(...params),
	}
}
