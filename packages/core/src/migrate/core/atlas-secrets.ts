/**
 * The secrets a Postgres URL holds, masked wherever comb shows text: a URL comb names, a line comb
 * prints (maskSecrets, only the literal secrets of the URLs it was given, M79), and Atlas's own
 * output (scrubAtlasOutput, which also masks any other URL's password or secret query value).
 */

const REDACTED = "***"
const SECRET_KEY = /pass|secret|token|key/i

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

/** `text` with every secret of `urls` masked, the literal strings only: for a line comb prints (M79) */
function maskSecrets(text: string, urls: readonly string[]): string {
	const secrets = [...new Set(urls.flatMap(secretsOf))].sort((a, b) => b.length - a.length)
	let out = text
	for (const secret of secrets) out = out.replaceAll(secret, REDACTED)
	return out
}

/** `text` with every secret of `urls` masked, and any other URL's password or secret query value too */
function scrubAtlasOutput(text: string, urls: readonly string[]): string {
	return (
		maskSecrets(text, urls)
			.replace(/\b(postgres(?:ql)?:\/\/[^:/\s@]+:)[^@\s]+@/g, `$1${REDACTED}@`)
			/* free text's key=value only: a JSON key such as "primary_key": is Atlas's structure, not a secret (M79) */
			.replace(/((?:^|[?&"\s])\w*(?:pass|secret|token|key)\w*=)[^&\s"]+/gi, `$1${REDACTED}`)
	)
}

export { maskSecrets, redactUrl, scrubAtlasOutput }
