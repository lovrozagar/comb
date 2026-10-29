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

/** `text` percent-decoded, or as written when an escape in it is malformed or decodes to no UTF-8 (P5) */
function decoded(text: string): string {
	try {
		return decodeURIComponent(text)
	} catch {
		// reason: the text as written is still a secret to mask; no decoding of it is
		return text
	}
}

/** Each secret as written, decoded, and encoded again, as Atlas may print any of them */
const spellings = (written: string): string[] => [written, decoded(written), encodeURIComponent(decoded(written))]

/**
 * The secret strings a URL holds, read from its text, so a URL WHATWG's URL refuses (a socket
 * target with a password, P14) or cannot decode (P5) still has each masked: the whole URL, its
 * password, and each secret-looking query value
 */
function secretsOf(raw: string): string[] {
	const match = /^[a-z][\w+.-]*:\/\/([^/?#]*)[^?#]*(?:\?([^#]*))?/i.exec(raw)
	if (match === null) return [raw]
	const [, authority = "", query = ""] = match
	const userinfo = authority.includes("@") ? authority.slice(0, authority.lastIndexOf("@")) : ""
	const password = userinfo.includes(":") ? userinfo.slice(userinfo.indexOf(":") + 1) : ""
	const values = query
		.split("&")
		.map((pair) => pair.split(/=(.*)/s))
		.filter(([key = "", value = ""]) => SECRET_KEY.test(decoded(key)) && value !== "")
		.map(([, value]) => value as string)
	return [raw, ...[password, ...values].flatMap(spellings)].filter((secret) => secret !== "")
}

/* a secret masked only where it stands as a token, so a password that is also part of a name leaves the name (P18) */
const asToken = (secret: string): RegExp =>
	new RegExp(`(?<![\\p{L}\\p{N}_])${secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "gu")

/** `text` with every secret of `urls` masked where it stands as a token, the literal strings only: for a line comb prints (M79) */
function maskSecrets(text: string, urls: readonly string[]): string {
	const secrets = [...new Set(urls.flatMap(secretsOf))].sort((a, b) => b.length - a.length)
	let out = text
	for (const secret of secrets) out = out.replace(asToken(secret), REDACTED)
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
