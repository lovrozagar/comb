/**
 * What an FTS sync trigger is, read once for every reader: the classifier's grammar, the schema
 * reader the engine and the rebuild guard take their exemptions from (M43). A sync trigger writes
 * only a row's own values, or the `'delete'` command, into FTS5 tables whose text lives elsewhere;
 * any other FTS5 command, `'delete-all'` among them, makes it a trigger like any other.
 */
import type { Dialect } from "../types.ts"
import { nameKey, QNAME } from "./sql-code.ts"

// per-process-constant: a pattern composed from the name grammar, compiled once
const SYNC_TRIGGER: RegExp = /* @__PURE__ */ new RegExp(
	`^CREATE (?:TEMP |TEMPORARY )?TRIGGER (?:IF NOT EXISTS )?(${QNAME}) (?:BEFORE|AFTER) (?:INSERT|DELETE|UPDATE(?: OF [^;]+?)?) ON ${QNAME}(?: FOR EACH ROW)? BEGIN (.+?);? END$`,
	"i",
)
// per-process-constant: a pattern composed from the name grammar, compiled once
const SYNC_WRITE = /* @__PURE__ */ new RegExp(
	`^INSERT INTO (${QNAME}) ?\\([^()]*\\) VALUES ?\\(((?:\\s*(?:(?:new|old)\\.[\\w"\`]+|'delete')\\s*,?)+)\\)$`,
	"i",
)

/**
 * The name of the trigger `text` makes, by its key, when every statement of its body syncs one of
 * `fts`; undefined for any other statement. `text` keeps its literals (the `'delete'` command is
 * one), without comments and its final semicolon.
 */
function syncTriggerOf(text: string, fts: ReadonlySet<string>, dialect: Dialect): string | undefined {
	const [, name, body] = SYNC_TRIGGER.exec(text) ?? []
	if (name === undefined || body === undefined) return undefined
	const synced = body
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "")
		.every((write) => {
			const target = SYNC_WRITE.exec(write)?.[1]
			return target !== undefined && fts.has(nameKey(target, dialect))
		})
	return synced ? nameKey(name, dialect) : undefined
}

export { SYNC_TRIGGER, syncTriggerOf }
