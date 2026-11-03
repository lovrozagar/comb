/**
 * The query keys libpq reads itself, by what Atlas's driver, lib/pq, does with each (P15 and P6 of
 * r19, probed on Atlas v1.3.0 and Postgres 17). comb's own connections send none of them to the
 * server. lib/pq reads the keys marked "atlas" and sends any other to the server as a setting, which
 * Postgres refuses, so every Atlas call fails. comb strips such a key from the URLs Atlas gets when it
 * only tunes the connection, and refuses it, by name, when it asks for something Atlas cannot do.
 */

/**
 * What comb does with a libpq key: leave it to Atlas, strip it from Atlas's URLs, refuse it unless its
 * value is one of `unless`, or refuse it with the TLS files it belongs to (pg-url.ts's tlsProblems)
 */
type KeyRule = "atlas" | "strip" | "tls" | { refuse: string; unless?: readonly string[] | undefined }

// lookup-table: each libpq key, and what comb does with it; a refusal names what the key asks for
const KEYS: Readonly<Record<string, KeyRule>> = {
	channel_binding: { refuse: "SCRAM channel binding", unless: ["disable", "prefer"] },
	connect_timeout: "atlas",
	dbname: "atlas",
	fallback_application_name: "atlas",
	gssencmode: { refuse: "GSSAPI encryption", unless: ["disable", "prefer"] },
	gsslib: "strip",
	host: "atlas",
	hostaddr: "atlas",
	keepalives: "strip",
	keepalives_count: "strip",
	keepalives_idle: "strip",
	keepalives_interval: "strip",
	krbsrvname: "atlas",
	load_balance_hosts: "atlas",
	passfile: "atlas",
	password: "atlas",
	port: "atlas",
	require_auth: { refuse: "an authentication method" },
	requirepeer: { refuse: "the server process's user" },
	/* lib/pq reads it, and takes the service file's host, dbname and user over the URL's: refused by checkUrl */
	service: "atlas",
	ssl_max_protocol_version: "atlas",
	ssl_min_protocol_version: "atlas",
	sslcert: "atlas",
	sslcompression: "strip",
	sslcrl: { refuse: "a certificate revocation check" },
	sslcrldir: { refuse: "a certificate revocation check" },
	sslkey: "atlas",
	sslmode: "atlas",
	sslnegotiation: "atlas",
	/* a secret lib/pq sends the server, for a key it cannot read: refused with sslkey (5.3) */
	sslpassword: "tls",
	sslrootcert: "atlas",
	sslsni: "atlas",
	target_session_attrs: "atlas",
	tcp_user_timeout: "atlas",
	user: "atlas",
}

/** The keys libpq reads itself, which no server takes as a setting */
// lookup-table: KEYS's names
const LIBPQ_KEYS: ReadonlySet<string> = /* @__PURE__ */ new Set(/* @__PURE__ */ Object.keys(KEYS))

/** Whether comb strips `key`, as `value`, from the URLs Atlas gets */
function stripsForAtlas(key: string, value: string): boolean {
	const rule = KEYS[key]
	return rule === "strip" || (typeof rule === "object" && rule.unless?.includes(value) === true)
}

/** Why `field`'s query cannot reach Atlas: a key that asks for what Atlas's driver does not do, named with its value only where the value decides */
function keyProblems(field: "devUrl" | "url", params: ReadonlyMap<string, string>): string[] {
	return [...params].flatMap(([key, value]) => {
		const rule = KEYS[key]
		if (typeof rule !== "object" || rule.unless?.includes(value) === true) return []
		const named = rule.unless === undefined ? key : `${key}=${value}`
		return [
			`${field} asks for ${rule.refuse} (${named}), which Atlas's driver does not do: it sends the key to the server, which refuses it; drop it`,
		]
	})
}

export { keyProblems, LIBPQ_KEYS, stripsForAtlas }
