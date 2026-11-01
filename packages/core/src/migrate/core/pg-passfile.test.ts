/**
 * P7 of r18: a URL that names its password file through `passfile` is the connection, as libpq and
 * Atlas read it, so comb's own reads take the password from it too.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { postgresOptionsOf } from "./pg-url.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** A password file holding `text`, readable by its owner alone unless `mode` says otherwise */
function passfile(text: string, mode = 0o600): string {
	const dir = mkdtempSync(join(tmpdir(), "comb-passfile-"))
	dirs.push(dir)
	const file = join(dir, "pgpass")
	writeFileSync(file, text)
	chmodSync(file, mode)
	return file
}

const passwordOf = (url: string) => {
	const password = postgresOptionsOf(url, "url")["password"]
	return typeof password === "function" ? (password as () => string)() : password
}

/** The password a socket target in /srv/pg takes from `file` */
const socket = (file: string) => passwordOf(`postgres://app@/app?host=/srv/pg&passfile=${file}`)

describe("postgresOptionsOf with a passfile", () => {
	it("reads the first line that matches host, port, database and user, wildcards and escapes as libpq reads them", () => {
		const file = passfile(
			"# a comment\n\nnot:enough:fields\nother:5432:app:app:no\ndb:5432:app:app:s3c\\:ret\\\\\ndb:*:*:app:late\n",
		)
		expect(passwordOf(`postgres://app@db/app?passfile=${file}`)).toBe("s3c:ret\\")
		expect(passwordOf(`postgres://app@db:6543/other?passfile=${file}`)).toBe("late")
		expect(passwordOf(`postgres://nobody@db/app?passfile=${file}`)).toBe("")
	})

	it("matches a socket target as localhost, and leaves a URL's own password alone", () => {
		const file = passfile("localhost:5432:app:app:sock\n*:*:*:*:any\n")
		expect(passwordOf(`postgres://app@/app?host=/run/postgresql&passfile=${file}`)).toBe("sock")
		expect(passwordOf(`postgres://app:mine@db/app?passfile=${file}`)).toBe("mine")
	})

	/*
	 * P11 of r19, ruled: the host rule of Atlas's driver, lib/pq, where it and libpq differ, so comb and
	 * Atlas take one password from one file (runs/2840532-probe-p11-passfile-*): no host is localhost
	 * whatever the hostaddr, and a socket matches its directory or localhost, the first line either way
	 */
	it("matches a hostaddr-only URL as localhost, never by its hostaddr, and a URL with both by its host", () => {
		const file = passfile("10.0.0.5:5432:app:app:addr\nlocalhost:5432:app:app:local\ndb:5432:app:app:named\n")
		expect(passwordOf(`postgres://app@/app?hostaddr=10.0.0.5&passfile=${file}`)).toBe("local")
		expect(passwordOf(`postgres://app@db/app?hostaddr=10.0.0.5&passfile=${file}`)).toBe("named")
		expect(passwordOf(`postgres://app@/app?passfile=${file}`)).toBe("local")
	})

	it("matches a socket by its directory or localhost, whichever line comes first", () => {
		expect(socket(passfile("/srv/pg:5432:app:app:path\n"))).toBe("path")
		expect(socket(passfile("localhost:5432:app:app:local\n/srv/pg:5432:app:app:path\n"))).toBe("local")
		expect(socket(passfile("/srv/pg:5432:app:app:path\nlocalhost:5432:app:app:local\n"))).toBe("path")
		expect(socket(passfile("/run/postgresql:5432:app:app:other\n"))).toBe("")
	})

	it("reads no password from a missing file, as libpq reads none", () => {
		expect(passwordOf("postgres://app@db/app?passfile=/nowhere/pgpass")).toBe("")
		/* nor from one it cannot stat or open, as libpq and lib/pq read none, silently (P24 of r19) */
		const file = passfile("*:*:*:*:pw\n")
		expect(passwordOf(`postgres://app@db/app?passfile=${file}/below`)).toBe("")
		chmodSync(file, 0o000)
		expect(passwordOf(`postgres://app@db/app?passfile=${file}`)).toBe("")
		const closed = passfile("*:*:*:*:pw\n")
		chmodSync(dirname(closed), 0o000)
		try {
			expect(passwordOf(`postgres://app@db/app?passfile=${closed}`)).toBe("")
		} finally {
			chmodSync(dirname(closed), 0o700)
		}
	})

	it("refuses a file others can read, naming passfile, as libpq ignores one", () => {
		const file = passfile("*:*:*:*:open\n", 0o644)
		expect(() => postgresOptionsOf(`postgres://app@db/app?passfile=${file}`, "url")).toThrow(
			`passfile ${file} can be read by others, so libpq ignores it; chmod 600 it`,
		)
	})
})
