import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { pgUrlProblems, type PgTarget } from "./atlas-target.ts"

const dir = mkdtempSync(join(tmpdir(), "comb-hosts-"))
const OPEN = join(dir, "open")
writeFileSync(OPEN, "*:*:*:*:pw\n")
chmodSync(OPEN, 0o644)
const OWN = join(dir, "own")
writeFileSync(OWN, "*:*:*:*:pw\n")
chmodSync(OWN, 0o600)

/** What pgUrlProblems says of `url` as the target, its devUrl elsewhere */
const problems = (url: string, over: Partial<PgTarget> = {}) =>
	pgUrlProblems({
		devUrl: "postgres://dev@localhost/dev?sslmode=disable",
		lockTimeout: "5s",
		schema: "public",
		url,
		...over,
	})
/** The plaintext warning for `reached` */
const plaintext = (reached: string) =>
	`url reaches ${reached} without sslmode=verify-full or require, so the password may cross the network unencrypted or to an unverified server`

/** What pgUrlProblems says of several hosts in `field` */
const several = (field: string) => `${field} names several hosts; comb migrates one database, so name its primary alone`

/* P16 of r19: a URL with no sslmode is require to comb and Atlas alike (P19 of r18), and system is verify-full */
describe("pgUrlProblems: the plaintext warning reads the sslmode comb connects with", () => {
	it("does not warn of a URL with no sslmode, or with sslrootcert=system alone", () => {
		expect(problems("postgres://app:pw@db.example.com/app").warnings).toEqual([])
		expect(problems("postgres://app:pw@db.example.com/app?sslrootcert=system").warnings).toEqual([])
	})

	it("still warns of disable, allow and prefer", () => {
		for (const mode of ["disable", "allow", "prefer"])
			expect(problems(`postgres://app:pw@db.example.com/app?sslmode=${mode}`).warnings, mode).toEqual([
				plaintext("db.example.com"),
			])
	})
})

/* P22 of r19: every loopback address stays on the machine */
describe("pgUrlProblems: the plaintext warning on a loopback address", () => {
	it.each(["127.0.0.2", "127.255.255.254", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]"])(
		"does not warn of %s, as host or as hostaddr",
		(address) => {
			expect(problems(`postgres://app:pw@${address}:5432/app?sslmode=disable`).warnings).toEqual([])
			const bare = address.replace(/^\[(.*)\]$/, "$1")
			expect(problems(`postgres://app:pw@db.example.com/app?sslmode=disable&hostaddr=${bare}`).warnings).toEqual([])
		},
	)

	it("still warns of an address that only looks local", () => {
		expect(problems("postgres://app:pw@db.example.com/app?sslmode=disable&hostaddr=fe80::1%25eth0").warnings).toEqual([
			plaintext("fe80::1%eth0"),
		])
		expect(problems("postgres://app:pw@128.0.0.1/app?sslmode=disable").warnings).toEqual([plaintext("128.0.0.1")])
		expect(problems("postgres://app:pw@127.example.com/app?sslmode=disable").warnings).toEqual([
			plaintext("127.example.com"),
		])
	})
})

/* P23 of r19: comb migrates one database; a host list is refused by name, wherever the URL spells it */
describe("pgUrlProblems: several hosts", () => {
	it.each([
		"postgres://app:secret@db1.example.com:5432,db2.example.com:5432/app?sslmode=require",
		"postgres://app:secret@db1.example.com,db2.example.com/app?sslmode=require",
		"postgres://app@/app?host=db1.example.com,db2.example.com&sslmode=require",
		"postgres://app@db.example.com/app?hostaddr=10.0.0.1,10.0.0.2&sslmode=require",
		"postgres://app@db.example.com/app?port=5432,5433&sslmode=require",
	])("refuses %s on url and devUrl", (url) => {
		expect(problems(url).errors).toEqual([several("url")])
		expect(problems("postgres://app@db.example.com/app?sslmode=require", { devUrl: url }).errors).toEqual([
			several("devUrl"),
		])
	})
})

/* P24 of r19: the passfile is checked before Atlas runs, as libpq judges it, and named by field */
describe("pgUrlProblems: the passfile", () => {
	it("refuses a directory as not a plain file, and a file others can read, on url and devUrl", () => {
		expect(problems(`postgres://app@db.example.com/app?sslmode=require&passfile=${dir}`).errors).toEqual([
			`url's passfile ${dir} is not a plain file, so libpq ignores it; name the password file itself`,
		])
		expect(
			problems("postgres://app@db.example.com/app?sslmode=require", {
				devUrl: `postgres://dev@localhost/dev?passfile=${OPEN}`,
			}).errors,
		).toEqual([`devUrl's passfile ${OPEN} can be read by others, so libpq ignores it; chmod 600 it`])
	})

	/* libpq reads a passfile only for a URL without a password, as comb's own read does (runs/*-p55-gates-20261101T215319Z: /dev/null) */
	it("passes any passfile beside a URL's own password, which libpq never reads", () => {
		expect(problems(`postgres://app:pw@db.example.com/app?sslmode=require&passfile=${dir}`).errors).toEqual([])
		expect(problems(`postgres://app:pw@db.example.com/app?sslmode=require&passfile=${OPEN}`).errors).toEqual([])
		expect(problems("postgres://app:pw@db.example.com/app?sslmode=require&passfile=/dev/null").errors).toEqual([])
	})

	it("passes the owner's own file, and a missing one, which gives no password as libpq's does", () => {
		expect(problems(`postgres://app@db.example.com/app?sslmode=require&passfile=${OWN}`).errors).toEqual([])
		expect(problems("postgres://app@db.example.com/app?sslmode=require&passfile=/nowhere/pgpass").errors).toEqual([])
		/* libpq and lib/pq read a passfile they cannot stat as none, silently */
		expect(problems(`postgres://app@db.example.com/app?sslmode=require&passfile=${OWN}/below`).errors).toEqual([])
	})
})
