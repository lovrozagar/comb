/**
 * The destructive-change gate on statements whose effect is what they run at apply time: a
 * prepared statement executed later in the file, a rule's action, a sequence reset through
 * setval, rows loaded by COPY, ownership handed to a role that bypasses row level security, and
 * a SQLite pragma comb does not write itself (writable_schema can corrupt the schema).
 */
import type { Finding } from "./classify-alter.ts"
import { writeFindings } from "./classify-write.ts"
import { IDENT, lastPart } from "./sql-code.ts"

// per-process-constant: patterns composed from the name grammar, compiled once
const PREPARE = /* @__PURE__ */ new RegExp(`^PREPARE (${IDENT})(?: ?\\([^)]*\\))? AS (.+)$`, "i")
// per-process-constant: see above
const EXECUTE = /* @__PURE__ */ new RegExp(`^EXECUTE (${IDENT})`, "i")
const RULE_ACTION = /^CREATE (?:OR REPLACE )?RULE .*?\bDO (?:ALSO |INSTEAD )?(?!\(|NOTHING\b)(.+)$/i
const SETVAL = /\b(?:pg_catalog ?\. ?)?setval ?\(/i
const PRAGMA = /^PRAGMA (?:\w+ ?\. ?)?(\w+)/i
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
	if (SETVAL.test(code)) findings.push({ level: "cautious", note: "sets a sequence, as a RESTART does" })
	if (/^COPY\b.*\bFROM\b/i.test(code)) findings.push({ level: "cautious", note: "loads rows into a table" })
	if (/^REASSIGN OWNED\b/i.test(code))
		findings.push({ level: "cautious", note: "an owner bypasses row level security" })
	const pragma = pragmaFinding(code)
	if (pragma !== undefined) findings.push(pragma)
	return findings
}

export { preparedOf, runtimeFindings }
