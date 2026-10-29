/**
 * The ALTER TABLE commands on a whole table, rated by what they do to its rows and to who sees them:
 * cautious, a rewrite, nothing, or unsafe for one comb does not list, named in the SQL's own words.
 * A trigger re-enabled is cautious, as its DISABLE is: its function runs on later writes again
 * (P10 of the 0.15.0 review).
 */
import type { Finding } from "./classify-alter.ts"
import { REWRITES } from "./pg-column-add.ts"
import type { Node } from "./pg-nodes.ts"

// lookup-table: the ALTER TABLE commands that change which rows a role sees, or what keeps them, and lose no value
const CAUTIOUS_COMMANDS = /* @__PURE__ */ new Set([
	"AT_ChangeOwner",
	"AT_ColumnDefault",
	"AT_DetachPartition",
	"AT_DetachPartitionFinalize",
	"AT_DisableTrig",
	"AT_DisableTrigAll",
	"AT_DisableTrigUser",
	"AT_DropConstraint",
	"AT_DropExpression",
	"AT_DropIdentity",
])

// lookup-table: the ALTER TABLE commands that rewrite the whole table under an ACCESS EXCLUSIVE lock and lose no value
const REWRITE_COMMANDS = /* @__PURE__ */ new Set(["AT_SetAccessMethod", "AT_SetTableSpace"])

// lookup-table: the row level security commands, cautious, each saying whose rows it changes
const SECURITY_COMMANDS = /* @__PURE__ */ new Set([
	"AT_DisableRowSecurity",
	"AT_EnableRowSecurity",
	"AT_ForceRowSecurity",
	"AT_NoForceRowSecurity",
])

// lookup-table: the ALTER TABLE commands that change no stored value, rated by nothing
const QUIET_COMMANDS = /* @__PURE__ */ new Set([
	"AT_AddIdentity",
	"AT_AlterConstraint",
	"AT_ClusterOn",
	"AT_DropCluster",
	"AT_DropNotNull",
	"AT_ResetOptions",
	"AT_ResetRelOptions",
	"AT_SetCompression",
	"AT_SetIdentity",
	"AT_SetOptions",
	"AT_SetRelOptions",
	"AT_SetStatistics",
	"AT_SetStorage",
	"AT_ValidateConstraint",
])

// lookup-table: the commands that turn a trigger back on, the ones of every trigger or every user trigger by their own
const ENABLES: Readonly<Record<string, "every" | "one">> = {
	AT_EnableAlwaysTrig: "one",
	AT_EnableReplicaTrig: "one",
	AT_EnableTrig: "one",
	AT_EnableTrigAll: "every",
	AT_EnableTrigUser: "every",
}

// lookup-table: the commands whose subtype, split into words, is not the SQL that writes them
const SPELLED: Readonly<Record<string, string>> = {
	AT_AddInherit: "INHERIT",
	AT_AddOf: "OF",
	AT_DropInherit: "NO INHERIT",
	AT_DropOf: "NOT OF",
}

/** A trigger turned back on: cautious, as the function it runs fires on later writes */
function enableFindings(cmd: Node, table: string): Finding[] {
	const note =
		ENABLES[String(cmd["subtype"])] === "every"
			? `turns on every trigger of ${table}, whose functions run on later writes`
			: `turns on trigger ${String(cmd["name"])} of ${table}, whose function runs on later writes`
	return [{ level: "cautious", note }]
}

/** The words an unlisted command is named by: the SQL's own where its subtype's split is not, as AT_AddInherit is INHERIT */
const wordsOf = (subtype: string): string =>
	SPELLED[subtype] ??
	subtype
		.replace(/^AT_/, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toUpperCase()

/** A command on the whole table: its findings; one comb does not list is unsafe, named in words */
function tableFindings(cmd: Node, table: string): Finding[] {
	const subtype = String(cmd["subtype"])
	if (CAUTIOUS_COMMANDS.has(subtype)) return [{ level: "cautious" }]
	if (ENABLES[subtype] !== undefined) return enableFindings(cmd, table)
	if (REWRITE_COMMANDS.has(subtype)) return [{ level: "lock", note: REWRITES }]
	/* SET LOGGED and SET UNLOGGED rewrite the table; an unlogged one loses its rows to a crash */
	if (subtype === "AT_SetLogged") return [{ level: "cautious" }, { level: "lock", note: REWRITES }]
	if (subtype === "AT_SetUnLogged")
		return [
			{ level: "cautious", note: `makes ${table} unlogged: its rows are emptied after a crash and not replicated` },
			{ level: "lock", note: REWRITES },
		]
	if (SECURITY_COMMANDS.has(subtype))
		return [{ level: "cautious", note: `changes which rows each role sees on ${table}` }]
	if (QUIET_COMMANDS.has(subtype)) return []
	return [
		{ level: "unsafe", note: `comb does not recognize ALTER TABLE … ${wordsOf(subtype)}; approve it in the file` },
	]
}

export { tableFindings }
