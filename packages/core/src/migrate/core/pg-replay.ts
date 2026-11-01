/**
 * The history replayed on the dev database, comb's objects and all, then read with the target's own
 * catalog query (P5 of r19): Postgres, not a model of it, decides what a cascade, a rename or a move
 * leaves, and the two sides compare as one read of two databases.
 *
 * The replay is one transaction, rolled back: nothing commits on dev, so it stays the empty scratch
 * Atlas requires, and nothing outside the target schema (a cast, an event trigger, an extension)
 * leaks there. Postgres refuses a few statements in a transaction block. CONCURRENTLY is cleared
 * from an index build, drop or reindex and a partition's detach: the parse tree says the statement
 * has it, comb's scanner cuts that one keyword, and the reparsed tree must equal the original with
 * only the flag cleared. VACUUM, a bare CLUSTER, a REINDEX of a database or the system, and a
 * detach's FINALIZE change no catalog row the read compares, so they are skipped. Any other
 * statement Postgres runs only outside a transaction stops the baseline, naming it; check's replay
 * of the pending files (pg-check-replay.ts) leaves it out and says so (P13 of r19).
 */
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import { maskSecrets } from "./atlas-secrets.ts"
import type { PgTarget } from "./atlas-target.ts"
import { ReplayFailed } from "./replay-failed.ts"
import { type Connect, failureOf, loadPostgres, readCatalog } from "./pg-live-objects.ts"
import type { LiveObjects } from "./pg-live-types.ts"
import { parsePostgres } from "./pg-parser.ts"
import { pgRead } from "./pg-split.ts"
import { postgresOptionsOf } from "./pg-url.ts"
import { segments } from "./sql-scan.ts"

type Node = Record<string, unknown>

/** A history file as baseline reads it */
type HistoryFile = { name: string; sql: string }

/* why comb loads postgres.js here */
const REPLAYS = "baseline replays the history on devUrl, and reads what it leaves, through the `postgres` package"

/**
 * The statements Postgres runs only outside a transaction block, by parse-tree node, which the one
 * replay transaction cannot hold; SKIPPED names those it leaves out instead
 */
// lookup-table: the node types a transaction block refuses, with what they are
const OUTSIDE_TRANSACTION: Readonly<Record<string, string>> = {
	AlterSystemStmt: "ALTER SYSTEM",
	CreateSubscriptionStmt: "CREATE SUBSCRIPTION",
	CreateTableSpaceStmt: "CREATE TABLESPACE",
	CreatedbStmt: "CREATE DATABASE",
	DropSubscriptionStmt: "DROP SUBSCRIPTION",
	DropTableSpaceStmt: "DROP TABLESPACE",
	DropdbStmt: "DROP DATABASE",
}

// lookup-table: the REINDEX kinds that reach every index of a database, which a transaction refuses
const WHOLE: ReadonlySet<string> = /* @__PURE__ */ new Set(["REINDEX_OBJECT_DATABASE", "REINDEX_OBJECT_SYSTEM"])

/** An ALTER TABLE's commands */
const commandsOf = (node: Node): Node[] =>
	(node["cmds"] as Array<{ AlterTableCmd: Node }>).map((cmd) => cmd.AlterTableCmd)

// lookup-table: the statements the replay skips, which change no catalog row the read compares
const SKIPPED: ReadonlyArray<(type: string, node: Node) => boolean> = [
	(type, node) => type === "VacuumStmt" && node["is_vacuumcmd"] === true,
	(type, node) => type === "ClusterStmt" && node["relation"] === undefined,
	(type, node) => type === "ReindexStmt" && WHOLE.has(String(node["kind"])),
	/* a CONCURRENTLY detach replays in full, so its FINALIZE has nothing left to finish */
	(type, node) =>
		type === "AlterTableStmt" && commandsOf(node).some((cmd) => cmd["subtype"] === "AT_DetachPartitionFinalize"),
]

/** A statement's one node: its type and fields */
const nodeOf = (tree: unknown): [string, Record<string, unknown>] => {
	/* a statement's tree is the parser's one RawStmt, whose stmt holds one node */
	const [{ stmt }] = tree as [{ stmt: Node }]
	return Object.entries(stmt)[0] as [string, Node]
}

/** Whether a node is built CONCURRENTLY, as its parse tree marks it */
function concurrent(type: string, node: Node): boolean {
	if (type === "IndexStmt" || type === "DropStmt") return node["concurrent"] === true
	if (type === "AlterTableStmt")
		return commandsOf(node).some(
			(cmd) =>
				cmd["subtype"] === "AT_DetachPartition" &&
				((cmd["def"] as Node)["PartitionCmd"] as Node)["concurrent"] === true,
		)
	if (type !== "ReindexStmt") return false
	return ((node["params"] ?? []) as Array<{ DefElem: Node }>).some(
		({ DefElem }) => DefElem["defname"] === "concurrently",
	)
}

/** `tree` with its flag cleared and every offset left out: what the same statement without CONCURRENTLY parses to */
function withoutConcurrently(tree: unknown): string {
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(strip).filter((each) => each !== undefined)
		if (value === null || typeof value !== "object") return value
		/* REINDEX's flag is a param of its own */
		if (((value as Node)["DefElem"] as Node | undefined)?.["defname"] === "concurrently") return undefined
		const out: Node = {}
		for (const [key, field] of Object.entries(value as Node)) {
			if (key === "location" || key === "stmt_location" || key === "stmt_len" || key === "concurrent") continue
			const kept = strip(field)
			/* a REINDEX whose one param was the flag has none */
			if (!(Array.isArray(kept) && kept.length === 0 && key === "params")) out[key] = kept
		}
		return out
	}
	return JSON.stringify(strip(tree))
}

/** `sql`'s parse tree, or undefined where the cut left what the parser refuses (a REINDEX's option list left empty) */
function reparse(sql: string): unknown {
	try {
		return parsePostgres(sql).stmts
	} catch {
		// reason: a cut the parser refuses proves nothing, and the caller refuses the statement
		return undefined
	}
}

/**
 * `sql` without its one CONCURRENTLY keyword: the code tokens are read by comb's scanner, so the word
 * in a string, a comment or a quoted identifier is never touched, and the reparse proves only the flag changed
 */
function cutConcurrently(sql: string, tree: unknown): string {
	let out = ""
	let cut = false
	for (const { kind, text } of segments(sql, "postgres")) {
		if (kind !== "code" || cut) {
			out += text
			continue
		}
		const match = /\bCONCURRENTLY\b\s*/i.exec(text)
		if (match === null) out += text
		else {
			out += text.slice(0, match.index) + text.slice(match.index + match[0].length)
			cut = true
		}
	}
	const reparsed = cut ? reparse(out) : undefined
	if (reparsed === undefined || withoutConcurrently(reparsed) !== withoutConcurrently(tree)) {
		throw new Error(
			`comb could not replay ${JSON.stringify(sql)} without CONCURRENTLY, which a transaction refuses; baseline compares nothing`,
		)
	}
	return out
}

/** What the replay does with one statement: sends it (as written, or cut), skips it, or cannot hold it, and why */
type Step = { send: string } | { skip: true } | { cannot: "cut" | "transaction" | (string & {}) }

/**
 * What the replay does with one history statement. VACUUM, a bare CLUSTER, a REINDEX of a whole
 * database or system, and the FINALIZE of a detach the replay ran in full change no catalog row the
 * read compares, so they are skipped; a CONCURRENTLY build, drop, reindex or detach is sent without
 * the keyword; transaction control and the statements OUTSIDE_TRANSACTION names cannot be held.
 */
function stepOf(sent: string, tree: unknown): Step {
	if (tree === undefined) return { send: sent }
	const [type, node] = nodeOf(tree)
	if (SKIPPED.some((skipped) => skipped(type, node))) return { skip: true }
	if (type === "TransactionStmt") return { cannot: "transaction" }
	const outside = OUTSIDE_TRANSACTION[type]
	if (outside !== undefined) return { cannot: outside }
	if (!concurrent(type, node)) return { send: sent }
	try {
		return { send: cutConcurrently(sent, tree) }
	} catch {
		// reason: the cut's refusal is the caller's to word, baseline's or check's
		return { cannot: "cut" }
	}
}

/** Each history statement in `files`, in order, with the file it is from and what the replay does with it */
const stepsOf = (files: readonly HistoryFile[]): Array<{ file: string; sent: string; step: Step }> =>
	files.flatMap(({ name, sql }) =>
		pgRead(sql).statements.map(({ sent, tree }) => ({ file: name, sent, step: stepOf(sent, tree) })),
	)

/** Baseline's refusal of a history statement its one transaction cannot hold */
function cannotBaseline(sent: string, cannot: string): Error {
	const statement = JSON.stringify(sent)
	if (cannot === "cut")
		return new Error(
			`comb could not replay ${statement} without CONCURRENTLY, which a transaction refuses; baseline compares nothing`,
		)
	if (cannot === "transaction") {
		return new Error(
			`${statement}: baseline replays the history in one transaction of its own, which the file's transaction control would end; baseline compares nothing`,
		)
	}
	return new Error(
		`${statement}: ${cannot} runs only outside a transaction, and baseline replays the history in one; baseline compares nothing`,
	)
}

/** The statements baseline's replay sends for `files`, in order, each with the file it is from; throws for one it cannot hold */
function replayStatements(files: readonly HistoryFile[]): Array<{ file: string; sql: string }> {
	return stepsOf(files).flatMap(({ file, sent, step }) => {
		if ("cannot" in step) throw cannotBaseline(sent, step.cannot)
		return "send" in step ? [{ file, sql: step.send }] : []
	})
}

/**
 * `statements` run on `target`'s dev database in one transaction that is rolled back, the schema
 * made and searched first; then `after` on the same connection, inside it. A statement dev refuses
 * is named, with dev's error, as what was `doing`, and then what that `stops`
 */
async function onDev<T>(
	target: PgTarget,
	statements: ReadonlyArray<{ file: string; sql: string }>,
	{
		after,
		doing,
		load,
		stops,
	}: { after: (sql: ReturnType<Connect>) => Promise<T>; doing: string; load: () => Promise<Connect>; stops: string },
): Promise<T> {
	const connect = await load()
	const sql = connect({ ...postgresOptionsOf(target.devUrl, "devUrl"), max: 1, onnotice: () => undefined })
	const scrub = (text: string) => maskSecrets(text, [target.devUrl, target.url])
	try {
		await sql.unsafe("BEGIN", [])
		try {
			if (target.schema !== "public")
				await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${sqlIdentifier(target.schema)}`, [])
			await sql.unsafe(`SET LOCAL search_path TO ${sqlIdentifier(target.schema)}`, [])
			for (const { file, sql: statement } of statements) {
				try {
					await sql.unsafe(statement, [])
				} catch (error) {
					throw new ReplayFailed(
						`${file}: devUrl refused ${JSON.stringify(statement)} as ${doing}: ${scrub(failureOf(error, "devUrl"))}; ${stops}`,
						{ cause: error },
					)
				}
			}
			return await after(sql)
		} finally {
			await sql.unsafe("ROLLBACK", [])
		}
	} catch (error) {
		if (error instanceof ReplayFailed) throw error
		throw new ReplayFailed(`comb could not replay the history on devUrl: ${scrub(failureOf(error, "devUrl"))}`, {
			cause: error,
		})
	} finally {
		await sql.end()
	}
}

/**
 * The catalog the history `files` leave in `target`'s schema, replayed on its dev database in one
 * transaction that is rolled back, read by the target's own query (readCatalog). The role the replay
 * ran as stands for the target's role wherever the read names it (`targetUser`), as CURRENT_USER
 * names the role each database was built as
 */
async function replayCatalog(
	target: PgTarget,
	{ files, targetUser }: { files: readonly HistoryFile[]; targetUser: string },
	load: () => Promise<Connect> = () => loadPostgres(REPLAYS),
): Promise<LiveObjects> {
	return onDev(target, replayStatements(files), {
		after: async (sql) => asTarget(await readCatalog(sql, target.schema), targetUser),
		doing: "baseline replayed the history there",
		load,
		stops: "baseline compares nothing",
	})
}

/** `live` read on dev, with dev's role named as the target's wherever a policy names it (the reviewer's addition A) */
function asTarget(live: LiveObjects, targetUser: string): LiveObjects {
	const devUser = live.user
	if (devUser === targetUser) return live
	const spelled = /^(for \w+, to )(.*)(, (?:permissive|restrictive))$/
	const policies = new Map(
		[...live.policies].map(([table, each]) => [
			table,
			new Map(
				[...each].map(([name, how]) => {
					/* the catalog read spells every policy so (pg-live-catalog.ts) */
					const [, head, roles, tail] = spelled.exec(how) as RegExpExecArray as unknown as [
						string,
						string,
						string,
						string,
					]
					const mapped = roles
						.split(", ")
						.map((role) => (role === devUser ? targetUser : role))
						.sort()
					return [name, `${head}${mapped.join(", ")}${tail}`]
				}),
			),
		]),
	)
	return { ...live, policies, user: targetUser }
}

export { cutConcurrently, type HistoryFile, nodeOf, onDev, replayCatalog, replayStatements, stepsOf }
