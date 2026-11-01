/**
 * The history replayed on the dev database, comb's objects and all, then read with the target's own
 * catalog query (P5 of r19): Postgres, not a model of it, decides what a cascade, a rename or a move
 * leaves, and the two sides compare as one read of two databases.
 *
 * The replay is one transaction, rolled back: nothing commits on dev, so it stays the empty scratch
 * Atlas requires, and nothing outside the target schema (a cast, an event trigger, an extension)
 * leaks there. Postgres refuses a few statements in a transaction block. CONCURRENTLY is cleared
 * from an index build, drop or reindex: the parse tree says the statement has it, comb's scanner
 * cuts that one keyword, and the reparsed tree must equal the original with only the flag cleared.
 * VACUUM and a bare CLUSTER change no catalog row the read compares, so they are skipped. Any other
 * statement Postgres runs only outside a transaction stops the baseline, naming it.
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
 * replay transaction cannot hold; VACUUM and a bare CLUSTER are skipped instead (they leave no catalog row the read compares)
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

/** A statement's one node: its type and fields */
const nodeOf = (tree: unknown): [string, Record<string, unknown>] => {
	/* a statement's tree is the parser's one RawStmt, whose stmt holds one node */
	const [{ stmt }] = tree as [{ stmt: Node }]
	return Object.entries(stmt)[0] as [string, Node]
}

/** Whether a node is built CONCURRENTLY, as its parse tree marks it */
function concurrent(type: string, node: Node): boolean {
	if (type === "IndexStmt" || type === "DropStmt") return node["concurrent"] === true
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

/** What the replay sends for one history statement: as written, without CONCURRENTLY, or nothing; throws for one it cannot hold */
function replayed(sent: string, tree: unknown): string | undefined {
	if (tree === undefined) return sent
	const [type, node] = nodeOf(tree)
	if (type === "VacuumStmt" && node["is_vacuumcmd"] === true) return undefined
	if (type === "ClusterStmt" && node["relation"] === undefined) return undefined
	if (type === "TransactionStmt") {
		throw new Error(
			`${JSON.stringify(sent)}: baseline replays the history in one transaction of its own, which the file's transaction control would end; baseline compares nothing`,
		)
	}
	const outside = OUTSIDE_TRANSACTION[type]
	if (outside !== undefined) {
		throw new Error(
			`${JSON.stringify(sent)}: ${outside} runs only outside a transaction, and baseline replays the history in one; baseline compares nothing`,
		)
	}
	return concurrent(type, node) ? cutConcurrently(sent, tree) : sent
}

/** The statements the replay sends for `files`, in order, each with the file it is from */
function replayStatements(files: readonly HistoryFile[]): Array<{ file: string; sql: string }> {
	return files.flatMap(({ name, sql }) =>
		pgRead(sql).statements.flatMap(({ sent, tree }) => {
			const send = replayed(sent, tree)
			return send === undefined ? [] : [{ file: name, sql: send }]
		}),
	)
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
	const statements = replayStatements(files)
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
						`${file}: devUrl refused ${JSON.stringify(statement)} as baseline replayed the history there: ${scrub(failureOf(error, "devUrl"))}; baseline compares nothing`,
						{ cause: error },
					)
				}
			}
			return asTarget(await readCatalog(sql, target.schema), targetUser)
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

export { cutConcurrently, type HistoryFile, nodeOf, replayCatalog, replayStatements }
