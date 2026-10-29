/**
 * How comb hands Atlas a Postgres database without leaking it. The URLs travel only in the
 * child's environment (`COMB_ATLAS_URL`, `COMB_ATLAS_DEV_URL`), which a temporary atlas.hcl reads
 * with getenv, so they never reach argv, where any local user can read them. Each URL is checked
 * before Atlas sees it, scoped to the configured schema (`search_path`), and the target's lock wait
 * is bounded (`lock_timeout`). Every byte of Atlas output comb relays is scrubbed of secrets (atlas-secrets.ts). Each
 * schema keeps its own history: public the shared `atlas_schema_revisions`, any other its own.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scrubAtlasOutput } from "./atlas-secrets.ts"
import { RESERVED_SCHEMA_WORDS } from "./pg-keywords.ts"
import { type LibpqUrl, libpqUrl, queryParams, urlProblem, withParam } from "./pg-url.ts"

/** A Postgres database as Atlas reaches it: target, dev database, schema and lock wait */
type PgTarget = { devUrl: string; lockTimeout: string; schema: string; url: string }

/** What an Atlas call reads from its config: the target, the dev database, the migrations dir, and whose history */
type AtlasNeeds = {
	dev?: boolean | undefined
	dir?: string | undefined
	/** the target unscoped, for the one call that lists the database's schemas (M78) */
	allSchemas?: boolean | undefined
	/** a history other than the target's own, by its schema: the shared one 0.12 kept every schema's in (M77), or another schema's own (M78) */
	revisions?: string | undefined
	url?: boolean | undefined
}

/** The flags and environment an Atlas call runs with, its scratch directory, and the scrubber for its output */
type AtlasEnv = {
	args: readonly string[]
	dir: string
	env: Readonly<Record<string, string>>
	/** free text: the call's secrets, and any other URL's password or secret query value, masked */
	scrub(text: string): string
}

// lookup-table: hosts a password never leaves the machine for
const LOCAL_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
// lookup-table: sslmodes that encrypt the connection
const VERIFIED_SSL = /* @__PURE__ */ new Set(["require", "verify-ca", "verify-full"])
const PLAIN_SCHEMA = /^[a-z_][a-z0-9_$]*$/
/* where a URL comb cannot read goes wrong, by the part (N2): the password, unless the part is another */
const HINTS = {
	address: "percent-encode a % in the host or database name as %25",
	password: "percent-encode special characters (#, /, ?, @) in the password",
	query: "percent-encode a % in the query's values as %25",
	user: "percent-encode a % in the user name as %25",
}

/** Whether `raw` is Atlas's own docker:// dev database, such as docker://postgres/17/dev */
const isDocker = (raw: string): boolean => /^docker:\/\/[^#\s]+$/.test(raw)

/** Warnings for a target that may send its password unprotected, or that goes through a pooler; a socket crosses no network (P19) */
function hostWarnings(url: LibpqUrl): string[] {
	const warnings: string[] = []
	const sslmode = url.params.get("sslmode") ?? ""
	if (!url.socket && !LOCAL_HOSTS.has(url.host) && !VERIFIED_SSL.has(sslmode)) {
		warnings.push(
			`url reaches ${url.host} without sslmode=verify-full or require, so the password may cross the network unencrypted or to an unverified server`,
		)
	}
	if (url.host.includes("-pooler.")) {
		warnings.push(
			"url is a Neon pooled host; migrations need the direct one (drop -pooler), since a pooler drops the lock Atlas holds",
		)
	}
	if (url.port === 6543) {
		warnings.push(
			"url uses port 6543, Supabase's transaction pooler; migrations need the direct or session connection on 5432",
		)
	}
	return warnings
}

/**
 * The database a Postgres URL reaches, as libpq reads it (pg-url.ts): its host without case,
 * localhost for the loopback addresses and for a Unix socket, so a local socket and local TCP count
 * as one server; its port; and its database (M89)
 */
function databaseOf(url: LibpqUrl): string {
	/* a hostaddr is where libpq connects, whatever host names (P7 of the 0.15.0 review) */
	const named = (url.hostaddr ?? url.host).toLowerCase()
	const host = url.socket || LOCAL_HOSTS.has(named) ? "localhost" : named
	return `${host}:${url.port}/${url.database}`
}

/** One URL field checked: the URL as libpq reads it, a docker:// dev database, or the error that names the field (never its value) */
function checkUrl(field: "devUrl" | "url", raw: string): { docker?: true; error?: string; url?: LibpqUrl } {
	if (raw.trim() === "") return { error: `${field} is empty` }
	if (field === "devUrl" && isDocker(raw)) return { docker: true }
	const accepted = field === "devUrl" ? "a postgres:// or docker://" : "a postgres://"
	const url = libpqUrl(raw)
	const problem = urlProblem(raw)
	/* libpq reads a socket in a percent-encoded host, and Atlas refuses one (N3) */
	if (problem === "encoded socket")
		return {
			error: `${field} names a Unix socket as a percent-encoded host, which Atlas refuses; give its directory as ?host=, as in postgres://app@/db?host=/run/postgresql`,
		}
	if (url !== undefined) return { url }
	return { error: `${field} is not ${accepted} URL; ${HINTS[problem]}` }
}

/**
 * Why `schema` cannot be the target's: comb writes it unquoted, so it must be a name Postgres keeps
 * as written, never one it folds, cuts or reads as a keyword (M87)
 */
function schemaProblem(schema: string): string | undefined {
	if (!PLAIN_SCHEMA.test(schema)) {
		const folded = schema.toLowerCase()
		const fold = PLAIN_SCHEMA.test(folded) ? `: Postgres folds ${schema} to ${folded} where it is unquoted` : ""
		return `schema must be a lowercase plain name such as "public"${fold}`
	}
	/* a plain name is ASCII, one byte a character; Postgres keeps NAMEDATALEN - 1 of them */
	if (schema.length > 63)
		return "schema must be at most 63 bytes: Postgres cuts a longer name to 63, which names another schema"
	if (RESERVED_SCHEMA_WORDS.has(schema))
		return `schema must not be ${schema}, a word Postgres reserves: unquoted, it is refused or read as something else`
	return undefined
}

/** What is wrong with the URLs `needs` names before Atlas runs: errors refuse it, warnings are printed */
function pgUrlProblems(
	target: PgTarget,
	needs: AtlasNeeds = { dev: true, url: true },
): { errors: string[]; warnings: string[] } {
	const url = needs.url ? checkUrl("url", target.url) : {}
	const dev = needs.dev ? checkUrl("devUrl", target.devUrl) : {}
	const errors = [url.error, dev.error].filter((error): error is string => error !== undefined)
	/* the target guarded whenever it is configured, on a call that does not reach it too (M89) */
	const configured = libpqUrl(target.url)
	if (configured !== undefined && dev.url !== undefined && databaseOf(configured) === databaseOf(dev.url)) {
		errors.push("url and devUrl are the same database; Atlas empties the dev database, so give it its own")
	}
	const named = schemaProblem(target.schema)
	if (named !== undefined) errors.push(named)
	const scope = url.url?.params.get("search_path")
	if (scope !== undefined) {
		const fix = "comb migrates one: set schema to it, and drop search_path from the url"
		if (scope.includes(",")) errors.push(`the url's search_path names more than one schema (${scope}); ${fix}`)
		else if (scope !== target.schema)
			errors.push(`the url's search_path names ${scope}, but schema is ${target.schema}; ${fix}`)
	}
	if (!/^(?:0|\d+(?:ms|s|min))$/.test(target.lockTimeout))
		errors.push("lockTimeout must look like 5s, 1500ms, 1min or 0")
	return { errors, warnings: url.url === undefined ? [] : hostWarnings(url.url) }
}

/** `raw` scoped to `schema` unless it names a search_path itself; edited as text, which a socket target with a password needs (P14) */
const scoped = (raw: string, schema: string): string =>
	queryParams(raw).has("search_path") ? raw : withParam(raw, "search_path", schema)

/** `raw` with no search_path, so Atlas sees every schema of the database */
const unscoped = (raw: string): string => withParam(raw, "search_path")

/** The target URL Atlas gets: scoped to the schema, its lock wait bounded unless the URL sets one */
function atlasTargetUrl(target: PgTarget): string {
	const url = scoped(target.url, target.schema)
	const params = queryParams(url)
	const options = params.get("options") ?? ""
	const bounded = params.has("lock_timeout") || options.includes("lock_timeout")
	if (target.lockTimeout === "0" || bounded) return url
	return withParam(url, "options", `${options === "" ? "" : `${options} `}-c lock_timeout=${target.lockTimeout}`)
}

/** The dev URL Atlas gets: scoped to the schema like the target, since a scoped target needs a scoped dev database */
const atlasDevUrl = (target: PgTarget): string => scoped(target.devUrl, target.schema)

/** The schema Atlas keeps public's history in, as it always has */
const SHARED_REVISIONS = "atlas_schema_revisions"

/**
 * The schema Atlas keeps `target`'s history in: the shared one for public, and one of its own for
 * any other scope, so two schemas of one database never read each other's history. Postgres cuts a
 * name at 63 bytes, so a scope too long, or not a plain lower-case name, is named by its hash.
 */
function revisionsSchema(target: PgTarget): string {
	/* a search_path the url names is the schema itself, or pgUrlProblems refused it (M39) */
	const scope = target.schema
	if (scope === "public") return SHARED_REVISIONS
	const own = `${SHARED_REVISIONS}_${scope}`
	if (/^[a-z_][a-z0-9_]*$/.test(scope) && own.length <= 63) return own
	return `${SHARED_REVISIONS}_${createHash("sha256").update(scope).digest("hex").slice(0, 16)}`
}

/** Both URLs as Atlas gets them */
const atlasUrls = (target: PgTarget): { devUrl: string; url: string } => ({
	devUrl: atlasDevUrl(target),
	url: atlasTargetUrl(target),
})

/** A string HCL reads back as `value`: JSON-escaped, with interpolation markers doubled */
/* a function replacement, since "$$" in a replacement string means one "$" */
const hclString = (value: string) =>
	JSON.stringify(value)
		.replaceAll("${", () => "$${")
		.replaceAll("%{", () => "%%{")

/** The atlas.hcl for `needs`: getenv for each URL, and the history pinned to `revisions` */
function atlasConfig(needs: AtlasNeeds, revisions: string): string {
	const lines = ['env "comb" {']
	if (needs.url) lines.push('  url = getenv("COMB_ATLAS_URL")')
	if (needs.dev) lines.push('  dev = getenv("COMB_ATLAS_DEV_URL")')
	lines.push("  migration {")
	if (needs.dir !== undefined) lines.push(`    dir = ${hclString(`file://${needs.dir}`)}`)
	lines.push(`    revisions_schema = ${hclString(revisions)}`, "  }", "}", "")
	return lines.join("\n")
}

/**
 * Run `body` with an Atlas config for `target` and `needs` in a fresh 0700 directory, removed
 * afterwards however `body` ends. A target with errors is refused before anything is written.
 */
function withAtlasEnv<T>(target: PgTarget, needs: AtlasNeeds, body: (atlas: AtlasEnv) => T): T {
	const { errors } = pgUrlProblems(target, needs)
	if (errors.length > 0) throw new Error(errors.join("; "))
	const dir = mkdtempSync(join(tmpdir(), "comb-atlas-"))
	const remove = () => rmSync(dir, { force: true, recursive: true })
	let pending = false
	try {
		/* a dev-only call reads no history, and may have no target URL to scope one by */
		const revisions = needs.revisions ?? (needs.url === true ? revisionsSchema(target) : SHARED_REVISIONS)
		writeFileSync(join(dir, "atlas.hcl"), atlasConfig(needs, revisions), { mode: 0o600 })
		const env: Record<string, string> = {}
		if (needs.url) env["COMB_ATLAS_URL"] = needs.allSchemas === true ? unscoped(target.url) : atlasTargetUrl(target)
		if (needs.dev) env["COMB_ATLAS_DEV_URL"] = atlasDevUrl(target)
		const secrets = [target.url, target.devUrl, ...Object.values(env)].filter((url) => url !== "")
		const args = ["--config", `file://${join(dir, "atlas.hcl")}`, "--env", "comb"]
		const out = body({ args, dir, env, scrub: (text) => scrubAtlasOutput(text, secrets) })
		if (out instanceof Promise) {
			pending = true
			return out.finally(remove) as T
		}
		return out
	} finally {
		if (!pending) remove()
	}
}

/**
 * What Atlas said on stderr as it succeeded, a line each: comb passes each on as a warning, as Atlas
 * OSS may say it left part of a schema out of what it compared (plan 14's 5.4)
 */
const atlasNotices = (stderr: string): string[] =>
	stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")

export {
	atlasConfig,
	type AtlasEnv,
	type AtlasNeeds,
	atlasNotices,
	atlasUrls,
	pgUrlProblems,
	type PgTarget,
	revisionsSchema,
	SHARED_REVISIONS,
	withAtlasEnv,
}
