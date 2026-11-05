/**
 * Where a Postgres URL's hosts lead, for the checks before Atlas runs: the warnings for a password
 * that may cross the network unprotected or a pooler, read with any loopback address as local,
 * and whether the URL lists several hosts, which libpq and Atlas's driver try in turn
 * and comb never migrates.
 */
import { isIPv4 } from "node:net"
import { type LibpqUrl, sslmodeOf } from "./pg-url.ts"

/* a host, hostaddr or port list in the query, as written: a comma, raw or percent-encoded */
const LISTED = /[?&](?:host|hostaddr|port)=[^&]*(?:,|%2c)/i
// lookup-table: sslmodes that encrypt the connection
const VERIFIED_SSL = /* @__PURE__ */ new Set(["require", "verify-ca", "verify-full"])

/** Whether `host` is a loopback name or address: localhost, any of 127.0.0.0/8, or ::1 however IPv6 spells it */
function isLoopback(host: string): boolean {
	if (host === "localhost") return true
	const bare = host.replace(/^\[(.*)\]$/, "$1")
	if (isIPv4(bare)) return bare.startsWith("127.")
	if (!bare.includes(":")) return false
	try {
		/* WHATWG's URL writes an IPv6 address one way, an IPv4-mapped one in hex */
		const written = new URL(`http://[${bare}]`).hostname
		return written === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(written)
	} catch {
		// reason: the throw is the answer: no IPv6 address, so no loopback one
		return false
	}
}

/** Whether `raw` names several hosts: a comma in the authority's host list, or in its host, hostaddr or port query keys */
function namesSeveralHosts(raw: string): boolean {
	const authority = /^postgres(?:ql)?:\/\/([^/?#]*)/.exec(raw)?.[1] ?? ""
	return authority.slice(authority.lastIndexOf("@") + 1).includes(",") || LISTED.test(raw)
}

/** Warnings for a target that may send its password unprotected, or that goes through a pooler; a socket crosses no network */
function hostWarnings(url: LibpqUrl): string[] {
	const warnings: string[] = []
	/* the sslmode comb and Atlas connect with, require where none is named */
	const sslmode = sslmodeOf(url)
	/* the password goes where comb and Atlas connect: hostaddr when given, which a socket never is */
	const reached = url.hostaddr ?? url.host
	const local = url.hostaddr === undefined ? url.socket || isLoopback(url.host) : isLoopback(url.hostaddr)
	if (!local && !VERIFIED_SSL.has(sslmode)) {
		warnings.push(
			`url reaches ${reached} without sslmode=verify-full or require, so the password may cross the network unencrypted or to an unverified server`,
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

export { hostWarnings, isLoopback, namesSeveralHosts }
