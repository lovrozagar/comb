import { describe, expect, it } from "vitest"
import { atlasUrls, pgUrlProblems, withAtlasEnv, type PgTarget } from "./atlas-target.ts"

const BASE = "postgres://app@db.example/app?sslmode=require"
const target = (over: Partial<PgTarget> = {}): PgTarget => ({
	devUrl: "postgres://dev@localhost/dev?sslmode=disable",
	lockTimeout: "0",
	schema: "public",
	url: BASE,
	...over,
})
/** What pgUrlProblems says of a libpq service in `field` */
const SERVICE = (field: string) =>
	`${field} names a libpq service, which Atlas reads from ~/.pg_service.conf and comb does not; write its host, port, dbname and user into the URL`
const DRIVER = "Atlas's driver does not do: it sends the key to the server, which refuses it; drop it"

/*
 * P15 of r19, probed on Atlas v1.3.0 and Postgres 17 (runs/1da9682-probe-p15-keys-*): lib/pq sends each of
 * these libpq keys to the server as a setting, which fails every Atlas call. A key that only tunes the
 * connection is stripped from Atlas's URL; one that asks for a check is refused by name. sslpassword is
 * the class sweep's sibling: the record's list missed it, and it carries a secret.
 */
describe("pgUrlProblems: libpq keys Atlas's driver sends to the server", () => {
	it.each([
		["channel_binding=require", "url asks for SCRAM channel binding (channel_binding=require), which"],
		["gssencmode=require", "url asks for GSSAPI encryption (gssencmode=require), which"],
		["require_auth=scram-sha-256", "url asks for an authentication method (require_auth), which"],
		["requirepeer=postgres", "url asks for the server process's user (requirepeer), which"],
		["sslcrl=/etc/ssl/root.crl", "url asks for a certificate revocation check (sslcrl), which"],
		["sslcrldir=/etc/ssl/crl", "url asks for a certificate revocation check (sslcrldir), which"],
		["sslpassword=Key-Secret-77", "url asks for an encrypted sslkey's passphrase (sslpassword), which"],
	])("refuses %s on url and devUrl, naming the key and never a secret", (pair, said) => {
		expect(pgUrlProblems(target({ url: `${BASE}&${pair}` })).errors).toEqual([`${said} ${DRIVER}`])
		const dev = pgUrlProblems(target({ devUrl: `postgres://dev@localhost/dev?${pair}` })).errors
		expect(dev).toEqual([`${said.replace(/^url/, "devUrl")} ${DRIVER}`])
		expect(dev.join()).not.toContain("Key-Secret-77")
	})

	/* P6 of r19: Atlas reads the service file's host, dbname and user over the URL's, comb reads the URL */
	it("refuses a libpq service on url and devUrl", () => {
		expect(pgUrlProblems(target({ url: `${BASE}&service=prod` })).errors).toEqual([SERVICE("url")])
		expect(pgUrlProblems(target({ devUrl: "postgres://dev@localhost/dev?service=dev" })).errors).toEqual([
			SERVICE("devUrl"),
		])
	})
})

describe("atlasUrls: libpq keys that only tune the connection", () => {
	it.each([
		"keepalives=1",
		"keepalives_count=3",
		"keepalives_idle=30",
		"keepalives_interval=10",
		"gsslib=gssapi",
		"sslcompression=0",
		"channel_binding=prefer",
		"channel_binding=disable",
		"gssencmode=prefer",
		"gssencmode=disable",
	])("passes %s, which only tunes the connection, and strips it from both URLs Atlas gets", (pair) => {
		const t = target({ devUrl: `postgres://dev@localhost/dev?sslmode=disable&${pair}`, url: `${BASE}&${pair}` })
		expect(pgUrlProblems(t).errors).toEqual([])
		const key = pair.split("=")[0] as string
		const { devUrl, url } = atlasUrls(t)
		expect(new URL(url).searchParams.has(key), url).toBe(false)
		expect(new URL(devUrl).searchParams.has(key), devUrl).toBe(false)
		const unscoped = withAtlasEnv(t, { allSchemas: true, url: true }, (env) => env.env["COMB_ATLAS_URL"] as string)
		expect(new URL(unscoped).searchParams.has(key), unscoped).toBe(false)
	})

	it("keeps every key Atlas's driver reads in the URLs Atlas gets", () => {
		const read = "connect_timeout=10&fallback_application_name=x&target_session_attrs=any&sslsni=1"
		const { url } = atlasUrls(target({ url: `${BASE}&${read}&keepalives=1` }))
		expect([...new URL(url).searchParams.keys()]).toEqual([
			"sslmode",
			"connect_timeout",
			"fallback_application_name",
			"target_session_attrs",
			"sslsni",
			"search_path",
		])
	})
})
