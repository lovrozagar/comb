/**
 * The pending files of a Postgres apply or check, each read once from the snapshot and classified
 * against the schema the files before it leave (atlas-apply.ts), before anything replays or runs
 * them, and on a check again after its replay
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ParsedMigration } from "../migration-types.ts"
import { sqlFiles } from "./atlas-dir.ts"
import type { Measured } from "./pg-check-replay.ts"
import { movesStorage } from "./pg-live-storage.ts"
import type { Placed } from "./pg-storage-types.ts"
import { extractSchema, parseRead } from "./parse.ts"
import { pgRead } from "./pg-split.ts"
import { schemaOfRead } from "./schema.ts"

/** `read()`, a file `name` Atlas cannot split refused by name */
function named<T>(name: string, read: () => T): T {
	try {
		return read()
	} catch (error) {
		throw new Error(`comb could not read ${name}: ${(error as Error).message}`, { cause: error })
	}
}

/** How a check or apply classifies its pending files: with what check's replay `measured`, and where the target's catalog `placed` its relations */
type Classify = (also: { measured?: Measured | undefined; placed?: Placed | undefined }) => ParsedMigration[]

/**
 * Each pending file read once from the snapshot, against the schema the files before it
 * leave, names keyed under the target's schema; returns its classifier, which classifies each as
 * Postgres and refuses a statement no approval clears, from the file alone, and whether a pending
 * file moves a relation to an access method or a tablespace, which only the target's catalog says
 * a relation the history made without USING or TABLESPACE may already be in. A check
 * that replays the files on devUrl classifies them again with what the replay `measured` of each,
 * where Postgres decides what the history's text cannot show (pg-scope.ts, pg-replay-held.ts)
 */
export function readPending(
	options: { target: { schema: string } },
	copy: string,
	waiting: ReadonlySet<string>,
): { classify: Classify; moves: boolean } {
	/* names are keyed as Postgres resolves them under the URL's search_path, the target's schema */
	const readAs = { dialect: "postgres" as const, schema: options.target.schema }
	let schema = extractSchema("", undefined, readAs)
	/* a file before a pending one that Postgres's parser cannot read leaves its facts unknown */
	let unread: string | undefined
	/* the history's statement the first pending file starts at, where the applied files end */
	let at: number | undefined
	let moves = false
	const reads: { before: typeof schema; file: Parameters<typeof parseRead>[0] }[] = []
	for (const Name of sqlFiles(copy)) {
		const sql = readFileSync(join(copy, Name), "utf8")
		if (waiting.has(Name) && unread !== undefined) throw new Error(unread)
		const before = schema
		/* the file's one parse, for the schema it leaves and, pending, its approval */
		const file = { dialect: "postgres" as const, read: named(Name, () => pgRead(sql)), sql }
		schema = schemaOfRead(file, readAs.schema, before)
		const { unreadable } = file.read
		unread ??=
			unreadable && `comb could not read ${Name}: ${JSON.stringify(unreadable.statement)} (${unreadable.error})`
		if (!waiting.has(Name)) continue
		at ??= before.statements.length
		moves ||= movesStorage(file.read.statements.map(({ tree }) => tree))
		reads.push({ before, file: { ...file, filename: Name } })
	}
	const classify: Classify = ({ measured, placed }) =>
		reads.map(({ before, file }) =>
			parseRead(
				file,
				{ before, schema: readAs.schema },
				{
					placing: placed === undefined ? undefined : { at: at as number, placed },
					replayed: measured === undefined ? undefined : (measured.get(file.filename) ?? { held: new Map() }),
				},
			),
		)
	return { classify, moves }
}
