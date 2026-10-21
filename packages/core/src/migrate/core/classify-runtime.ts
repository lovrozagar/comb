/**
 * The destructive-change gate on statements whose effect is what they run at apply time or after: a
 * prepared statement executed later in the file, a rule (an INSTEAD NOTHING one discards writes) and its action, a SQLite trigger's body (run by
 * every later write to its table), a sequence reset through setval, rows loaded by COPY,
 * ownership handed to a role that bypasses row level security, and a SQLite pragma comb does not
 * write itself (writable_schema can corrupt the schema).
 */
import type { Finding } from "./classify-alter.ts"
import { writeFindings } from "./classify-write.ts"
import { IDENT, lastPart } from "./sql-code.ts"

// per-process-constant: patterns composed from the name grammar, compiled once
const PREPARE = /* @__PURE__ */ new RegExp(`^PREPARE (${IDENT})(?: ?\\([^)]*\\))? AS (.+)$`, "i")
// per-process-constant: see above
const EXECUTE = /* @__PURE__ */ new RegExp(`^EXECUTE (${IDENT})`, "i")
const RULE_ACTION = /^CREATE (?:OR REPLACE )?RULE .*?\bDO (?:ALSO |INSTEAD )?(?!\(|NOTHING\b)(.+)$/i
// per-process-constant: a rule's event, its table and whether it replaces the event, composed once
const RULE = /* @__PURE__ */ new RegExp(
	`^CREATE (?:OR REPLACE )?RULE ${IDENT} AS ON (SELECT|INSERT|UPDATE|DELETE) TO (${IDENT}(?: ?\\. ?${IDENT})?)\\b.*?\\bDO (INSTEAD )?(NOTHING\\b)?`,
	"i",
)
const SETVAL = /\b(?:pg_catalog ?\. ?)?setval ?\(/i
const PRAGMA = /^PRAGMA (?:\w+ ?\. ?)?(\w+)/i
// per-process-constant: a SQLite trigger, its table, and its BEGIN … END body
const TRIGGER = /* @__PURE__ */ new RegExp(
	`^CREATE (?:TEMP |TEMPORARY )?TRIGGER (?:IF NOT EXISTS )?${IDENT}(?: ?\\. ?${IDENT})? .*?\\bON (${IDENT}(?: ?\\. ?${IDENT})?)(.*)$`,
	"i",
)
// per-process-constant: the pragma comb writes into a SQLite rebuild (atlas-env.ts)
const COMB_PRAGMAS = /* @__PURE__ */ new Set(["defer_foreign_keys"])

/** The statements a file prepares, by name, with the code each runs */
function preparedOf(codes: readonly string[]): Map<string, string> {
	const out = new Map<string, string>()
	for (const code of codes) {
		const [, name, body] = PREPARE.exec(code) ?? []
		if (name !== undefined && body !== undefined) out.set(lastPart(name), body)
	}
	return out
}

/** The findings of a pragma: writable_schema unsafe, any other comb does not write cautious */
function pragmaFinding(code: string): Finding | undefined {
	const name = PRAGMA.exec(code)?.[1]?.toLowerCase()
	if (name === undefined || COMB_PRAGMAS.has(name)) return undefined
	return name === "writable_schema"
		? { level: "unsafe", note: "lets a statement rewrite the schema itself" }
		: { level: "cautious", note: "changes how SQLite runs what follows" }
}

/**
 * A rule's own finding: one that does INSTEAD NOTHING on a write turns every later such write into
 * a no-op that succeeds, which loses what the deployed code writes; any other INSTEAD rule
 * replaces what the code asked for
 */
function ruleFinding(code: string): Finding | undefined {
	const [, event, table, instead, nothing] = RULE.exec(code) ?? []
	if (event === undefined || instead === undefined) return undefined
	if (nothing !== undefined && event.toUpperCase() !== "SELECT") {
		return { level: "unsafe", note: `silently discards every ${event.toUpperCase()} on ${lastPart(table as string)}` }
	}
	return { level: "cautious", note: `replaces every ${event.toUpperCase()} on ${lastPart(table as string)}` }
}

/**
 * A trigger's findings: each statement of a SQLite BEGIN … END body as a write that runs on every
 * later write to its table, so nothing it touches is a fresh backfill; a trigger that neither has
 * such a body nor executes a function runs code comb cannot read
 */
function triggerFindings(code: string): Finding[] {
	const [, on, rest] = TRIGGER.exec(code) ?? []
	if (on === undefined) return []
	const body = /\bBEGIN\b(.*)\bEND$/i.exec(rest as string)?.[1]
	if (body === undefined) {
		return /\bEXECUTE (?:FUNCTION|PROCEDURE)\b/i.test(rest as string)
			? []
			: [{ level: "cautious", note: "a trigger whose body comb cannot read" }]
	}
	const note = `runs on every later write to ${lastPart(on)}`
	return body
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "")
		.flatMap((part) => writeFindings(part).map((finding) => ({ ...finding, note })))
}

/**
 * The findings of one statement for what it runs at apply time; `read` classifies the code an
 * EXECUTE runs, `prepared` holds what the file prepares
 */
function runtimeFindings(
	code: string,
	prepared: ReadonlyMap<string, string>,
	read: (code: string) => Finding[],
): Finding[] {
	const findings: Finding[] = []
	const executed = EXECUTE.exec(code)?.[1]
	const body = executed === undefined ? undefined : prepared.get(lastPart(executed))
	if (body !== undefined) findings.push(...read(body))
	else if (executed !== undefined || /^EXECUTE\b/i.test(code))
		findings.push({ level: "cautious", note: "runs a prepared statement comb cannot read" })
	const action = RULE_ACTION.exec(code)?.[1]
	if (action !== undefined) findings.push(...writeFindings(action))
	const rule = ruleFinding(code)
	if (rule !== undefined) findings.push(rule)
	findings.push(...triggerFindings(code))
	if (SETVAL.test(code)) findings.push({ level: "cautious", note: "sets a sequence, as a RESTART does" })
	if (/^COPY\b.*\bFROM\b/i.test(code)) findings.push({ level: "cautious", note: "loads rows into a table" })
	if (/^CREATE POLICY\b.*\bAS RESTRICTIVE\b/i.test(code))
		findings.push({
			level: "cautious",
			note: "a restrictive policy hides the rows it does not pass from every role it applies to",
		})
	if (/^REASSIGN OWNED\b/i.test(code))
		findings.push({ level: "cautious", note: "an owner bypasses row level security" })
	const pragma = pragmaFinding(code)
	if (pragma !== undefined) findings.push(pragma)
	return findings
}

export { preparedOf, runtimeFindings }
