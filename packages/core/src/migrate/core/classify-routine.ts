/**
 * The routines a file creates, each body read as the code it runs: a call of one anywhere (a
 * SELECT, an INSERT's values, a CREATE TABLE AS, a default, a trigger's EXECUTE FUNCTION) runs
 * what its body does, so the call gets the body's strictest finding. A body in another language,
 * or a routine an earlier file created, whose body this file does not hold, runs code comb cannot
 * read. A few Postgres built-ins destroy data or run unread SQL wherever they are called.
 */
import type { Dialect } from "../types.ts"
import type { Finding } from "./classify-alter.ts"
import { doBody, nameKey, QNAME } from "./sql-code.ts"

// per-process-constant: patterns composed from the name grammar, compiled once
const CREATE_ROUTINE = /* @__PURE__ */ new RegExp(`^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE) (${QNAME})`, "i")
// per-process-constant: see above
const CALLED = /* @__PURE__ */ new RegExp(`(${QNAME})\\s*\\(`, "g")
const READABLE = /\bLANGUAGE '?(?:sql|plpgsql)'?(?:\s|$)/i
const RANK: Record<Finding["level"], number> = { cautious: 1, lock: 0, unsafe: 2 }

/** The Postgres built-ins whose call destroys data, runs SQL comb cannot read, or ends other sessions */
const BUILTINS: Readonly<Record<string, Finding>> = {
	dblink: { level: "cautious", note: "calls dblink, which runs SQL comb cannot read" },
	dblink_exec: { level: "cautious", note: "calls dblink_exec, which runs SQL comb cannot read" },
	lo_truncate: { level: "unsafe", note: "calls lo_truncate, which cuts a large object" },
	lo_unlink: { level: "unsafe", note: "calls lo_unlink, which deletes a large object" },
	pg_cancel_backend: { level: "cautious", note: "calls pg_cancel_backend, which cancels another session's query" },
	pg_terminate_backend: { level: "cautious", note: "calls pg_terminate_backend, which ends another session" },
}

/** Each routine the file creates, by name: what a call of it runs, or nothing when its body is harmless */
type Routines = Map<string, Finding | undefined>

/** The strictest of `findings` that is not a lock warning, or nothing */
function strictest(findings: readonly Finding[]): Finding | undefined {
	return findings
		.filter((finding) => finding.level !== "lock")
		.reduce<Finding | undefined>(
			(top, finding) => (top === undefined || RANK[finding.level] > RANK[top.level] ? finding : top),
			undefined,
		)
}

/**
 * The routines among a file's statements and their codes; `read` classifies a body as the
 * statements it runs (with nothing fresh, as it runs when called)
 */
function routinesOf(
	file: { codes: readonly string[]; dialect: Dialect; statements: readonly string[] },
	read: (body: string) => Finding[],
): Routines {
	const { codes, dialect, statements } = file
	const out: Routines = new Map()
	for (const [i, code] of codes.entries()) {
		const name = CREATE_ROUTINE.exec(code)?.[1]
		if (name === undefined) continue
		const body = doBody(statements[i] as string)
		const key = nameKey(name, dialect)
		if (body.trim() === "" || !READABLE.test(code)) {
			out.set(key, { level: "cautious", note: `calls ${key}, whose body comb cannot read` })
			continue
		}
		const top = strictest(read(body))
		out.set(
			key,
			top === undefined
				? undefined
				: {
						level: top.level,
						note: `calls ${key}, whose body ${top.level === "unsafe" ? "loses data" : "changes data"}`,
					},
		)
	}
	return out
}

/** What a file knows of its routines: its own, by what a call runs, and the names of earlier files' ones */
type KnownRoutines = { dialect: Dialect; earlier: ReadonlySet<string>; routines: Routines }

/** The findings of the routine calls in `code`: a routine of this file by its body, an earlier one cautious */
function callFindings(code: string, { dialect, earlier, routines }: KnownRoutines): Finding[] {
	if (CREATE_ROUTINE.test(code)) return []
	const findings: Finding[] = []
	for (const match of code.matchAll(CALLED)) {
		const key = nameKey(match[1] as string, dialect)
		const builtin = dialect === "postgres" && !routines.has(key) ? BUILTINS[key] : undefined
		if (builtin !== undefined) findings.push(builtin)
		else if (routines.has(key)) {
			const finding = routines.get(key)
			if (finding !== undefined) findings.push(finding)
		} else if (earlier.has(key))
			findings.push({ level: "cautious", note: `calls ${key}, which an earlier migration created` })
	}
	return findings
}

export { callFindings, type Routines, routinesOf }
