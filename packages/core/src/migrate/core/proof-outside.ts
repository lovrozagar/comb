/**
 * What a statement's compiled program does outside the database it runs on. The proof runs each
 * statement on its in-memory copy (proof-engine.ts), so one that opens or writes another file, or
 * loads code into the process, would act on the real machine during a read-only `check`.
 */

import { preview } from "./classify-file.ts"

/* the functions SQLite compiles a statement that reaches outside its database into, each by the
   statement that names it: ATTACH and DETACH, and an extension loaded into the process */
const OUTSIDE_FUNCTIONS: ReadonlyArray<[prefix: string, statement: string]> = [
	["sqlite_attach(", "ATTACH"],
	["sqlite_detach(", "DETACH"],
	["load_extension(", "load_extension"],
]

/**
 * The statement a program runs that acts outside the database it runs on, read from its opcodes, its
 * triggers' subprograms included: an attached database file, a library loaded into the process, or
 * the file a `VACUUM INTO` writes (its P2 holds the file's name; a plain VACUUM's is 0)
 */
function outsideReach(ops: ReadonlyArray<Record<string, unknown>>): string | undefined {
	for (const op of ops) {
		if (op["opcode"] === "Vacuum" && Number(op["p2"]) !== 0) return "VACUUM INTO"
		const called = /Func/.test(String(op["opcode"])) ? String(op["p4"]) : ""
		const found = OUTSIDE_FUNCTIONS.find(([prefix]) => called.startsWith(prefix))
		if (found !== undefined) return found[1]
	}
	return undefined
}

/** Refuses the statement `sql` whose program `ops` reaches outside the copy: the copy runs what it proves, so this is refused before it runs, and no approval overrides it */
function refuseOutside(ops: ReadonlyArray<Record<string, unknown>>, sql: string): void {
	const outside = outsideReach(ops)
	if (outside === undefined) return
	throw new Error(
		`${preview(sql)}: comb never runs ${outside} in a migration: it reaches outside the database the migration applies to, and D1 refuses it`,
	)
}

export { outsideReach, refuseOutside }
