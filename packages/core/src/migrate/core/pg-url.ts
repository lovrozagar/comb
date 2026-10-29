/**
 * A Postgres URL read as libpq reads it (P3, P4, P14 and P19 of the 0.14.1 review), for each part of
 * comb that reaches the database itself or judges where a URL reaches: a query key over the URI's
 * part for the host, port, database, user and password, the userinfo percent-decoded, and a host
 * that is a path a Unix socket's directory. WHATWG's URL takes no socket target with a password,
 * and postgres.js reads none of libpq's query keys and sends each one it does not know to the
 * server as a setting, so neither reads a URL here.
 */
import { readFileSync } from "node:fs"

/** Where a Postgres URL reaches, and its query, every key decoded */
type LibpqUrl = {
	database: string
	/** a host name or address, or a Unix socket's directory */
	host: string
	params: ReadonlyMap<string, string>
	password: string | undefined
	port: number
	socket: boolean
	user: string
}

/* scheme://[userinfo@][host][:port][/dbname][?query], with no fragment */
const URI = /^postgres(?:ql)?:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?$/
/* a host in brackets (an IPv6 address) or bare, then its port */
const HOST_PORT = /^(?:\[([^\]]*)\]|([^:[\]]*))(?::(\d*))?$/

// lookup-table: the keys libpq reads itself, which no server takes as a setting
const LIBPQ_KEYS = /* @__PURE__ */ new Set([
	"channel_binding",
	"connect_timeout",
	"dbname",
	"gssencmode",
	"gsslib",
	"host",
	"hostaddr",
	"keepalives",
	"keepalives_count",
	"keepalives_idle",
	"keepalives_interval",
	"krbsrvname",
	"load_balance_hosts",
	"passfile",
	"password",
	"port",
	"require_auth",
	"requirepeer",
	"service",
	"ssl_max_protocol_version",
	"ssl_min_protocol_version",
	"sslcert",
	"sslcompression",
	"sslcrl",
	"sslcrldir",
	"sslkey",
	"sslnegotiation",
	"sslmode",
	"sslpassword",
	"sslrootcert",
	"sslsni",
	"target_session_attrs",
	"tcp_user_timeout",
	"user",
])

/** A URL's query as libpq reads it: each key and value percent-decoded, a `+` kept as written */
function queryParams(raw: string): Map<string, string> {
	const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : ""
	const params = new Map<string, string>()
	for (const pair of query.split("&")) {
		if (pair === "") continue
		const [key = "", value = ""] = pair.split(/=(.*)/s)
		params.set(decodeURIComponent(key), decodeURIComponent(value))
	}
	return params
}

/** `raw` with its `key` query parameter set to `value`, or removed when `value` is undefined, the rest as written */
function withParam(raw: string, key: string, value?: string): string {
	const [base = "", query = ""] = raw.split(/\?(.*)/s)
	const kept = query
		.split("&")
		.filter((pair) => pair !== "" && decodeURIComponent(pair.split("=")[0] as string) !== key)
	if (value !== undefined) kept.push(`${key}=${encodeURIComponent(value)}`)
	return kept.length === 0 ? base : `${base}?${kept.join("&")}`
}

/** The user and password an authority's userinfo names, each percent-decoded */
function userinfoOf(authority: string): { password: string | undefined; user: string } {
	const userinfo = authority.includes("@") ? authority.slice(0, authority.lastIndexOf("@")) : ""
	const [user = "", password] = userinfo.split(/:(.*)/s).map(decodeURIComponent)
	return { password, user }
}

/**
 * The host and port an authority's host part names, libpq's query over it; an empty host is
 * localhost, as Atlas's driver reads it, since libpq's own default socket is no server Atlas reaches
 */
function hostOf(hostport: RegExpExecArray, params: ReadonlyMap<string, string>): { host: string; port: string } {
	const [, bracketed, plain = "", port = ""] = hostport
	const host = (params.get("host") ?? bracketed ?? decodeURIComponent(plain)) || "localhost"
	return { host, port: params.get("port") ?? (port || "5432") }
}

/** `raw` read as libpq reads it, or undefined for one it cannot read, a percent-escape that is no UTF-8 included */
function libpqUrl(raw: string): LibpqUrl | undefined {
	const [, authority = "", path = "", query = ""] = URI.exec(raw) ?? []
	const hostport = HOST_PORT.exec(authority.slice(authority.lastIndexOf("@") + 1))
	if (!URI.test(raw) || hostport === null) return undefined
	try {
		const params = queryParams(`?${query}`)
		const userinfo = userinfoOf(authority)
		const { host, port } = hostOf(hostport, params)
		if (!/^\d+$/.test(port)) return undefined
		const user = params.get("user") ?? userinfo.user
		const database = params.get("dbname") ?? decodeURIComponent(path.replace(/^\//, ""))
		return {
			database: database === "" ? user : database,
			host,
			params,
			password: params.get("password") ?? userinfo.password,
			port: Number(port),
			socket: host.startsWith("/"),
			user,
		}
	} catch {
		// reason: a URL libpq cannot decode is reported by its field name, never echoed
		return undefined
	}
}

/* a client file each TLS option reads, by the libpq key that names it */
const TLS_FILES = { ca: "sslrootcert", cert: "sslcert", key: "sslkey" } as const

/* verify-ca checks a server's certificate chain, never its host name */
const anyHost = (): undefined => undefined

/** postgres.js's `ssl` for `url`'s sslmode, its files read: none on a socket, libpq's prefer unnamed */
function sslOf(url: LibpqUrl): unknown {
	if (url.socket) return false
	const mode = url.params.get("sslmode") ?? "prefer"
	if (mode === "disable") return false
	if (mode === "allow" || mode === "prefer") return "prefer"
	const files = Object.fromEntries(
		Object.entries(TLS_FILES)
			.filter(([, key]) => url.params.has(key))
			.map(([option, key]) => [option, readFileSync(url.params.get(key) as string, "utf8")]),
	)
	/* libpq verifies a require's server against a root certificate it is given, as verify-ca does */
	if (mode === "verify-ca" || (mode === "require" && files["ca"] !== undefined))
		return { ...files, checkServerIdentity: anyHost, rejectUnauthorized: true }
	if (mode === "require") return "require"
	if (mode === "verify-full") return { ...files, rejectUnauthorized: true }
	throw new Error(`sslmode ${mode} is none libpq takes: disable, allow, prefer, require, verify-ca or verify-full`)
}

/** postgres.js's options for the database `url` reaches, as libpq reaches it: libpq's own keys read, the rest sent as settings */
function postgresOptions(url: LibpqUrl): Record<string, unknown> {
	const connection = Object.fromEntries([...url.params].filter(([key]) => !LIBPQ_KEYS.has(key)))
	const timeout = url.params.get("connect_timeout")
	return {
		...(Object.keys(connection).length === 0 ? {} : { connection }),
		...(timeout === undefined ? {} : { connect_timeout: Number(timeout) }),
		...(url.database === "" ? {} : { database: url.database }),
		host: url.host,
		...(url.password === undefined ? {} : { password: url.password }),
		port: url.port,
		ssl: sslOf(url),
		...(url.user === "" ? {} : { username: url.user }),
	}
}

/** postgres.js's options for the URL `raw`, which `field` names; a URL libpq cannot read refused by that name */
function postgresOptionsOf(raw: string, field: "devUrl" | "url"): Record<string, unknown> {
	const url = libpqUrl(raw)
	if (url === undefined) throw new Error(`${field} is not a postgres:// URL libpq can read`)
	return postgresOptions(url)
}

export { type LibpqUrl, libpqUrl, postgresOptionsOf, queryParams, withParam }
