import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { pgUrlProblems, type PgTarget } from "./atlas-target.ts"
import { postgresOptionsOf } from "./pg-url.ts"

const MISSING = "/nonexistent/x.pem"
const dir = mkdtempSync(join(tmpdir(), "comb-tls-"))
const PKCS8 = join(dir, "enc.key")
writeFileSync(PKCS8, "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF\n-----END ENCRYPTED PRIVATE KEY-----\n")
const LEGACY = join(dir, "legacy.key")
writeFileSync(
	LEGACY,
	"-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,00\n\nMIIE\n-----END RSA PRIVATE KEY-----\n",
)
const PLAIN = join(dir, "plain.key")
writeFileSync(PLAIN, "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n")

/** What pgUrlProblems refuses of a target with `over` */
const at = (over: Partial<PgTarget>) =>
	pgUrlProblems({
		devUrl: "postgres://dev@localhost/dev?sslmode=disable",
		lockTimeout: "5s",
		schema: "public",
		url: "postgres://app@localhost/app",
		...over,
	}).errors

/** What pgUrlProblems says of sslrootcert=system under sslmode `mode` in `field` */
const weakSystem = (field: string, mode: string) =>
	`${field}'s sslmode ${mode} may not be used with sslrootcert=system, which libpq and Atlas's driver refuse; use sslmode=verify-full`

/** What pgUrlProblems says of the encrypted `key` */
const encrypted = (key: string) =>
	`url's sslkey ${key} is encrypted, which Atlas's driver cannot read; give it an unencrypted key (openssl pkey -in ${key} -out unencrypted.key)`

/** What pgUrlProblems says of an sslpassword for `key` */
const passphrase = (key: string) =>
	`url's sslpassword is a passphrase Atlas's driver cannot use: it reads no encrypted sslkey, and sends sslpassword to the server, which refuses it; give it an unencrypted key (openssl pkey -in ${key} -out unencrypted.key), and drop sslpassword`

/** postgres.js's ssl for db.example with `query` */
const ssl = (query: string) => postgresOptionsOf(`postgres://db.example/app?${query}`, "url")["ssl"]

/** What pgUrlProblems refuses of `query` as the target's url, and as its devUrl */
function refusals(query: string): { dev: string[]; url: string[] } {
	return {
		dev: at({ devUrl: `postgres://dev@localhost/dev?${query}` }),
		url: at({ url: `postgres://app@localhost/app?${query}` }),
	}
}

/* 5.3, probed on libpq 18, Atlas v1.3.0 and comb's own read (runs/f8909ff-probe-p7-tls-*): none reads a TLS file under these */
describe("pgUrlProblems: TLS files under an sslmode that reads none", () => {
	it.each(["disable", "allow", "prefer"])(
		"passes a missing sslrootcert, sslcert or sslkey under sslmode=%s",
		(mode) => {
			for (const key of ["sslrootcert", "sslcert", "sslkey"])
				expect(refusals(`sslmode=${mode}&${key}=${MISSING}`), key).toEqual({ dev: [], url: [] })
		},
	)

	it.each(["sslmode=require&", "sslmode=verify-ca&", "sslmode=verify-full&", ""])(
		"still refuses a missing file under %s, which comb's own read opens",
		(mode) => {
			expect(refusals(`${mode}sslrootcert=${MISSING}`)).toEqual({
				dev: [`devUrl's sslrootcert ${MISSING} cannot be read`],
				url: [`url's sslrootcert ${MISSING} cannot be read`],
			})
		},
	)
})

/* P7 of r19: libpq 16+ and lib/pq take system as the OS trust store, only with verify-full, which it implies */
describe("pgUrlProblems: sslrootcert=system", () => {
	it("passes it with sslmode=verify-full, and with no sslmode, which it makes verify-full", () => {
		expect(refusals("sslmode=verify-full&sslrootcert=system")).toEqual({ dev: [], url: [] })
		expect(refusals("sslrootcert=system")).toEqual({ dev: [], url: [] })
	})

	it.each(["disable", "allow", "prefer", "require", "verify-ca"])(
		"refuses it with sslmode=%s, as libpq does",
		(mode) => {
			expect(refusals(`sslmode=${mode}&sslrootcert=system`)).toEqual({
				dev: [weakSystem("devUrl", mode)],
				url: [weakSystem("url", mode)],
			})
		},
	)
})

/* the reviewer's ruling on 5.2's sslpassword: lib/pq cannot read an encrypted sslkey, with or without its passphrase */
describe("pgUrlProblems: an encrypted sslkey", () => {
	it.each([PKCS8, LEGACY])("refuses %s, naming the openssl line that decrypts it", (key) => {
		expect(refusals(`sslmode=require&sslkey=${key}`).url).toEqual([encrypted(key)])
	})

	/* lib/pq sends sslpassword to the server under any sslmode (refused as a setting), and reads no encrypted key where it reads one */
	it("refuses sslpassword under any sslmode, beside the key or without it, never naming its value", () => {
		expect(refusals(`sslmode=require&sslkey=${PKCS8}&sslpassword=Key-Secret-77`).url).toEqual([passphrase(PKCS8)])
		const alone = refusals("sslmode=prefer&sslpassword=Key-Secret-77")
		expect(alone.url).toEqual([passphrase("<sslkey>")])
		expect(JSON.stringify(alone)).not.toContain("Key-Secret-77")
	})

	it("passes an unencrypted key, and an encrypted one under an sslmode that falls back to no TLS (runs/f8909ff-probe-p7-enc-modes-*)", () => {
		expect(refusals(`sslmode=require&sslkey=${PLAIN}`)).toEqual({ dev: [], url: [] })
		for (const mode of ["disable", "allow", "prefer"])
			expect(refusals(`sslmode=${mode}&sslkey=${PKCS8}`), mode).toEqual({ dev: [], url: [] })
	})
})

describe("postgresOptionsOf: sslrootcert=system", () => {
	it("verifies the server's name against Node's own CAs, with verify-full or no sslmode, and names the host where hostaddr connects", () => {
		expect(ssl("sslmode=verify-full&sslrootcert=system")).toEqual({ rejectUnauthorized: true })
		expect(ssl("sslrootcert=system")).toEqual({ rejectUnauthorized: true })
		expect(ssl("hostaddr=10.0.0.5&sslrootcert=system")).toEqual({ rejectUnauthorized: true, servername: "db.example" })
	})

	it("refuses it with a weaker sslmode, as libpq does", () => {
		expect(() => postgresOptionsOf("postgres://db/app?sslmode=require&sslrootcert=system", "url")).toThrow(
			"url's sslmode require may not be used with sslrootcert=system, which libpq and Atlas's driver refuse; use sslmode=verify-full",
		)
	})
})
