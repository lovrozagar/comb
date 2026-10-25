/**
 * What an FTS sync trigger is, read once for every reader: the classifier's grammar, the schema
 * reader the engine and the rebuild guard take their exemptions from (M43). A sync trigger writes
 * only a row's own values, or the `'delete'` command, into FTS5 tables whose text lives elsewhere;
 * any other FTS5 command, `'delete-all'` among them, makes it a trigger like any other.
 */
import { lastPart, nameKey, type Naming, QNAME } from "./sql-code.ts"

// per-process-constant: a pattern composed from the name grammar, compiled once
const SYNC_TRIGGER: RegExp = /* @__PURE__ */ new RegExp(
	`^CREATE (?:TEMP |TEMPORARY )?TRIGGER (?:IF NOT EXISTS )?(${QNAME}) (?:BEFORE|AFTER) (?:INSERT|DELETE|UPDATE(?: OF [^;]+?)?) ON ${QNAME}(?: FOR EACH ROW)? BEGIN (.+?);? END$`,
	"i",
)
// per-process-constant: a pattern composed from the name grammar, compiled once
const SYNC_WRITE = /* @__PURE__ */ new RegExp(`^INSERT INTO (${QNAME}) ?\\(([^()]*)\\) VALUES ?\\(([^()]*)\\)$`, "i")
/* a row's own value, as a sync write takes it */
const ROW_VALUE = /^(?:new|old)\.[\w"`]+$/i

/* a column or value list's entries, as a sync write's simple lists hold them */
const listOf = (list: string | undefined): string[] => (list as string).split(",").map((part) => part.trim())

/**
 * Whether `write` syncs one of `fts`: each column takes its value by position,
 * the table's own column and rank only the 'delete' command (FTS5 reads what lands there as one),
 * every other column a row's own value
 */
function syncsTable(write: string, fts: ReadonlySet<string>, naming: Naming): boolean {
	const [, target, columnList, valueList] = SYNC_WRITE.exec(write) ?? []
	if (target === undefined || !fts.has(nameKey(target, naming))) return false
	const [columns, values] = [listOf(columnList), listOf(valueList)]
	const own = nameKey(lastPart(target), naming)
	return (
		columns.length === values.length &&
		columns.every((column, i) => {
			const value = values[i] as string
			const command = nameKey(column, naming) === own || nameKey(column, naming) === "rank"
			return command ? /^'delete'$/i.test(value) : ROW_VALUE.test(value)
		})
	)
}

/**
 * The name of the trigger `text` makes, by its key, when every statement of its body syncs one of
 * `fts`; undefined for any other statement. `text` keeps its literals (the `'delete'` command is
 * one), without comments and its final semicolon.
 */
function syncTriggerOf(text: string, fts: ReadonlySet<string>, naming: Naming): string | undefined {
	const [, name, body] = SYNC_TRIGGER.exec(text) ?? []
	if (name === undefined || body === undefined) return undefined
	const synced = body
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "")
		.every((write) => syncsTable(write, fts, naming))
	return synced ? nameKey(name, naming) : undefined
}

export { SYNC_TRIGGER, syncTriggerOf }
