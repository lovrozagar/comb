/**
 * P15 and P6 of r19: every libpq key comb reads as libpq's own, through real Atlas. A key Atlas's
 * driver sends to the server as a setting fails every Atlas call, so comb strips it from Atlas's URL
 * or refuses it by name; this holds pg-url-keys.ts's table to what Atlas does, key by key.
 */
import { describe, expect, it } from "vitest"
import { pgUrlProblems, withAtlasEnv, type PgTarget } from "../../../src/migrate/core/atlas-target.ts"
import { run } from "../../../src/migrate/core/process.ts"
import { LIBPQ_KEYS } from "../../../src/migrate/core/pg-url-keys.ts"
import { pgUrl } from "../support/pg.ts"

const server = new URL(pgUrl() as string)
const file = import.meta.filename

/* a value for each key that, read, reaches the test server as its URL already does */
const PROBES: Readonly<Record<string, readonly string[]>> = {
	channel_binding: ["disable", "prefer", "require"],
	connect_timeout: ["10"],
	dbname: [server.pathname.slice(1)],
	fallback_application_name: ["comb"],
	gssencmode: ["disable", "prefer", "require"],
	gsslib: ["gssapi"],
	host: [server.hostname],
	hostaddr: ["127.0.0.1"],
	keepalives: ["1"],
	keepalives_count: ["3"],
	keepalives_idle: ["30"],
	keepalives_interval: ["10"],
	krbsrvname: ["postgres"],
	load_balance_hosts: ["disable"],
	passfile: ["/dev/null"],
	password: [decodeURIComponent(server.password)],
	port: [server.port],
	require_auth: ["password"],
	requirepeer: ["postgres"],
	service: ["comb"],
	ssl_max_protocol_version: ["TLSv1.3"],
	ssl_min_protocol_version: ["TLSv1.2"],
	sslcert: [file],
	sslcompression: ["0"],
	sslcrl: [file],
	sslcrldir: ["/tmp"],
	sslkey: [file],
	sslmode: ["disable"],
	sslnegotiation: ["postgres"],
	sslpassword: ["comb"],
	sslrootcert: [file],
	sslsni: ["1"],
	target_session_attrs: ["any"],
	tcp_user_timeout: ["0"],
	user: [decodeURIComponent(server.username)],
}

/** The test server's URL with `key` set to `value` */
function withKey(key: string, value: string): string {
	const url = new URL(server.href)
	url.searchParams.set(key, value)
	return url.href
}

/** Whether Atlas reads the database at `url`: inspect exits 0 */
const inspects = (url: string, env: Record<string, string> = {}, args: readonly string[] = ["-u", url]) =>
	run("atlas", ["schema", "inspect", ...args, "--format", "{{ len .Realm.Schemas }}"], { env })

describe("libpq keys through Atlas v1.3.0", () => {
	it("probes every key the table names, and only those", () => {
		expect(Object.keys(PROBES).sort()).toEqual([...LIBPQ_KEYS].sort())
	})

	const cases = Object.entries(PROBES).flatMap(([key, values]) => values.map((value) => [key, value] as const))
	it.each(cases)(
		"%s=%s: comb hands Atlas a URL it reads, or refuses it, as Atlas reads the key raw",
		async (key, value) => {
			const url = withKey(key, value)
			const raw = await inspects(url)
			const target: PgTarget = { devUrl: "docker://postgres/17/dev", lockTimeout: "0", schema: "public", url }
			const refused = pgUrlProblems(target, { url: true }).errors.length > 0
			const handed = refused
				? undefined
				: await withAtlasEnv(target, { allSchemas: true, url: true }, async (env) => {
						const ran = await inspects(env.env["COMB_ATLAS_URL"] as string, env.env, [...env.args])
						const kept = new URL(env.env["COMB_ATLAS_URL"] as string).searchParams.has(key)
						return ran.code === 0 ? (kept ? "kept" : "stripped") : `Atlas failed: ${ran.stderr}`
					})
			/* a key kept is one Atlas reads; one Atlas would send the server is stripped or refused */
			expect(raw.code === 0 ? ["kept"] : ["refused", "stripped"], raw.stderr).toContain(handed ?? "refused")
		},
	)
})
