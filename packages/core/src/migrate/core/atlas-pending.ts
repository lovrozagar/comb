/**
 * The pending files of a Postgres apply or check, each read once from the snapshot and classified
 * against the schema the files before it leave (atlas-apply.ts), before anything replays or runs them
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ParsedMigration } from "../types.ts"
import { sqlFiles } from "./atlas-dir.ts"
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

/**
 * Each pending file read from the snapshot, classified as Postgres against the schema the files
 * before it leave, names keyed under the target's schema; a statement no approval clears is
 * refused here, from the file alone (PA2 of r22b)
 */
export function classifyPending(
	options: { target: { schema: string } },
	copy: string,
	waiting: ReadonlySet<string>,
): ParsedMigration[] {
	/* names are keyed as Postgres resolves them under the URL's search_path, the target's schema (M72) */
	const readAs = { dialect: "postgres" as const, schema: options.target.schema }
	let schema = extractSchema("", undefined, readAs)
	/* a file before a pending one that Postgres's parser cannot read leaves its facts unknown (M75) */
	let unread: string | undefined
	const migrations: ParsedMigration[] = []
	for (const Name of sqlFiles(copy)) {
		const sql = readFileSync(join(copy, Name), "utf8")
		if (waiting.has(Name) && unread !== undefined) throw new Error(unread)
		const before = schema
		/* the file's one parse, for the schema it leaves and, pending, its approval (M86) */
		const file = { dialect: "postgres" as const, read: named(Name, () => pgRead(sql)), sql }
		schema = schemaOfRead(file, readAs.schema, before)
		const { unreadable } = file.read
		unread ??=
			unreadable && `comb could not read ${Name}: ${JSON.stringify(unreadable.statement)} (${unreadable.error})`
		if (waiting.has(Name)) migrations.push(parseRead({ ...file, filename: Name }, { before, schema: readAs.schema }))
	}
	return migrations
}
