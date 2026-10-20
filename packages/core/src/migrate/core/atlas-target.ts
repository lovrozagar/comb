/**
 * How comb hands Atlas a Postgres database without leaking it. The URLs travel only in the
 * child's environment (`COMB_ATLAS_URL`, `COMB_ATLAS_DEV_URL`), which a temporary atlas.hcl reads
 * with getenv, so they never reach argv, where any local user can read them. Each URL is checked
 * before Atlas sees it, scoped to the configured schema (`search_path`), and the target's lock wait
 * is bounded (`lock_timeout`). Every byte of Atlas output comb relays is scrubbed of secrets.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A Postgres database as Atlas reaches it: target, dev database, schema and lock wait */
type PgTarget = { devUrl: string; lockTimeout: string; schema: string; url: string }

/** What an Atlas call reads from its config: the target, the dev database, the migrations dir */
type AtlasNeeds = { dev?: boolean | undefined; dir?: string | undefined; url?: boolean | undefined }

/** The flags and environment an Atlas call runs with, its scratch directory, and the scrubber for its output */
type AtlasEnv = {
	args: readonly string[]
	dir: string
	env: Readonly<Record<string, string>>
	scrub(text: string): string
}

const REDACTED = "***"
const SECRET_KEY = /pass|secret|token|key/i
// lookup-table: hosts a password never leaves the machine for
const LOCAL_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
// lookup-table: sslmodes that encrypt the connection
const VERIFIED_SSL = /* @__PURE__ */ new Set(["require", "verify-ca", "verify-full"])
const ENCODE_HINT = "percent-encode special characters (#, /, ?, @) in the password"

/** `raw` as a URL with one of `schemes`, or undefined */
function parseUrl(raw: string, schemes: readonly string[]): URL | undefined {
	try {
		const url = new URL(raw)
		return schemes.includes(url.protocol) && url.hash === "" ? url : undefined
	} catch {
		// reason: an unparseable URL is reported by its field name, never echoed
		return undefined
	}
}

/** Warnings for a target that may send its password unprotected, or that goes through a pooler */
function hostWarnings(url: URL): string[] {
	const warnings: string[] = []
	const sslmode = url.searchParams.get("sslmode") ?? ""
	if (!LOCAL_HOSTS.has(url.hostname) && !VERIFIED_SSL.has(sslmode)) {
		warnings.push(
			`url reaches ${url.hostname} without sslmode=verify-full or require, so the password may cross the network unencrypted or to an unverified server`,
		)
	}
	if (url.hostname.includes("-pooler.")) {
		warnings.push(
			"url is a Neon pooled host; migrations need the direct one (drop -pooler), since a pooler drops the lock Atlas holds",
		)
	}
	if (url.port === "6543") {
		warnings.push(
			"url uses port 6543, Supabase's transaction pooler; migrations need the direct or session connection on 5432",
		)
	}
	return warnings
}

/** One URL field checked: the parsed URL, or the error that names the field (never its value) */
function checkUrl(field: "devUrl" | "url", raw: string, schemes: readonly string[]): { error?: string; url?: URL } {
	if (raw.trim() === "") return { error: `${field} is empty` }
	const url = parseUrl(raw, schemes)
	const accepted = schemes.includes("docker:") ? "a postgres:// or docker://" : "a postgres://"
	return url === undefined ? { error: `${field} is not ${accepted} URL; ${ENCODE_HINT}` } : { url }
}

/** What is wrong with the URLs `needs` names before Atlas runs: errors refuse it, warnings are printed */
function pgUrlProblems(
	target: PgTarget,
	needs: AtlasNeeds = { dev: true, url: true },
): { errors: string[]; warnings: string[] } {
	const url = needs.url ? checkUrl("url", target.url, ["postgres:", "postgresql:"]) : {}
	const dev = needs.dev ? checkUrl("devUrl", target.devUrl, ["postgres:", "postgresql:", "docker:"]) : {}
	const errors = [url.error, dev.error].filter((error): error is string => error !== undefined)
	if (url.url !== undefined && url.url.href === dev.url?.href) {
		errors.push("url and devUrl are the same database; Atlas empties the dev database, so give it its own")
	}
	if (!/^[A-Za-z_][\w$]*$/.test(target.schema)) errors.push('schema must be a plain name such as "public"')
	if (!/^(?:0|\d+(?:ms|s|min))$/.test(target.lockTimeout))
		errors.push("lockTimeout must look like 5s, 1500ms, 1min or 0")
	return { errors, warnings: url.url === undefined ? [] : hostWarnings(url.url) }
}

/** `raw` scoped to `schema` unless it names a search_path itself */
function scoped(raw: string, schema: string): URL {
	const url = new URL(raw)
	if (!url.searchParams.has("search_path")) url.searchParams.set("search_path", schema)
	return url
}

/** The target URL Atlas gets: scoped to the schema, its lock wait bounded unless the URL sets one */
function atlasTargetUrl(target: PgTarget): string {
	const url = scoped(target.url, target.schema)
	const options = url.searchParams.get("options") ?? ""
	const bounded = url.searchParams.has("lock_timeout") || options.includes("lock_timeout")
	if (target.lockTimeout !== "0" && !bounded) {
		url.searchParams.set("options", `${options === "" ? "" : `${options} `}-c lock_timeout=${target.lockTimeout}`)
	}
	return url.href
}

/** The dev URL Atlas gets: scoped to the schema like the target, since a scoped target needs a scoped dev database */
const atlasDevUrl = (target: PgTarget): string => scoped(target.devUrl, target.schema).href

/** Both URLs as Atlas gets them */
const atlasUrls = (target: PgTarget): { devUrl: string; url: string } => ({
	devUrl: atlasDevUrl(target),
	url: atlasTargetUrl(target),
})

/** `raw` with its password and every secret-looking query value masked; unparseable, masked whole */
function redactUrl(raw: string): string {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		// reason: a URL that does not parse cannot be partly masked, so none of it is shown
		return "<redacted url>"
	}
	if (url.password !== "") url.password = REDACTED
	/* a copy of the keys, since set() rewrites the list being read */
	const keys = Array.from(url.searchParams.keys())
	for (const key of keys) if (SECRET_KEY.test(key)) url.searchParams.set(key, REDACTED)
	return url.href.replaceAll(encodeURIComponent(REDACTED), REDACTED)
}

/** `text` percent-decoded, or as it is when it holds a `%` that starts no escape */
const decoded = (text: string): string => (/%(?![0-9a-f]{2})/i.test(text) ? text : decodeURIComponent(text))

/**
 * The secret strings a URL holds, as written and as Atlas may print them: the password is kept
 * percent-encoded by the URL, a query value comes back already decoded
 */
function secretsOf(raw: string): string[] {
	const url = URL.canParse(raw) ? new URL(raw) : undefined
	if (url === undefined) return [raw]
	const query = [...url.searchParams].filter(([key]) => SECRET_KEY.test(key)).map(([, value]) => value)
	const secrets = [url.password, decoded(url.password), ...query.flatMap((value) => [value, encodeURIComponent(value)])]
	return [raw, ...secrets].filter((secret) => secret !== "")
}

/** `text` with every secret of `urls` masked, and any other URL's password or secret query value too */
function scrubAtlasOutput(text: string, urls: readonly string[]): string {
	const secrets = [...new Set(urls.flatMap(secretsOf))].sort((a, b) => b.length - a.length)
	let out = text
	for (const secret of secrets) out = out.replaceAll(secret, REDACTED)
	return out
		.replace(/\b(postgres(?:ql)?:\/\/[^:/\s@]+:)[^@\s]+@/g, `$1${REDACTED}@`)
		.replace(/([?&"]\w*(?:pass|secret|token|key)\w*["]?[=:]["]?)[^&\s"]+/gi, `$1${REDACTED}`)
}

/** Atlas's failure in comb's terms where comb knows the fix; otherwise as Atlas said it */
function explainAtlasFailure(stderr: string): string {
	if (/Error: docker:|Cannot connect to the Docker daemon/i.test(stderr)) {
		return "Atlas needs Docker for the default devUrl (docker://postgres/17/dev); set devUrl to an empty Postgres database instead"
	}
	if (/lock is held by other session/.test(stderr)) {
		return "another migrate apply is running on this database; run it again once that one finishes"
	}
	if (/connected database is not clean/.test(stderr)) {
		return "the database has objects but no migration history; if its schema matches the migrations, record them with comb migrate baseline"
	}
	const late = /migration file (\S+) was added out of order/.exec(stderr)?.[1]
	if (late !== undefined) {
		return `${late} is older than a migration already applied; rename it to a newer version and run atlas migrate hash`
	}
	const [, value, type] = /dropping value "([^"]*)" from enum "([^"]*)" is not supported/.exec(stderr) ?? []
	if (value !== undefined) {
		return `Atlas cannot drop the value "${value}" of enum "${type}": write that migration by hand (a new type without it, the columns moved to it, the old type dropped), then run migrate diff again`
	}
	const refused = /(\w[\w ]*?) (?:is|are) available to logged-in users only/.exec(stderr)?.[1]
	return refused === undefined
		? stderr
		: `Atlas OSS does not diff ${refused.replace(/^Error: /, "")}: take them out of the drizzle schema and write their migration by hand, or use Atlas Pro`
}

/** A string HCL reads back as `value`: JSON-escaped, with interpolation markers doubled */
/* a function replacement, since "$$" in a replacement string means one "$" */
const hclString = (value: string) =>
	JSON.stringify(value)
		.replaceAll("${", () => "$${")
		.replaceAll("%{", () => "%%{")

/** The atlas.hcl for `needs`: getenv for each URL, and the history pinned to one schema; migrate init writes it too */
function atlasConfig(needs: AtlasNeeds): string {
	const lines = ['env "comb" {']
	if (needs.url) lines.push('  url = getenv("COMB_ATLAS_URL")')
	if (needs.dev) lines.push('  dev = getenv("COMB_ATLAS_DEV_URL")')
	lines.push("  migration {")
	if (needs.dir !== undefined) lines.push(`    dir = ${hclString(`file://${needs.dir}`)}`)
	lines.push('    revisions_schema = "atlas_schema_revisions"', "  }", "}", "")
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
		writeFileSync(join(dir, "atlas.hcl"), atlasConfig(needs), { mode: 0o600 })
		const env: Record<string, string> = {}
		if (needs.url) env["COMB_ATLAS_URL"] = atlasTargetUrl(target)
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

export {
	atlasConfig,
	type AtlasEnv,
	type AtlasNeeds,
	atlasUrls,
	explainAtlasFailure,
	pgUrlProblems,
	type PgTarget,
	redactUrl,
	scrubAtlasOutput,
	withAtlasEnv,
}
