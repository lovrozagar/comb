/**
 * P7 of r18: a URL that names its password file through `passfile` is the connection, as libpq and
 * Atlas read it, so comb's own reads take the password from it too.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

	it("reads no password from a missing file, as libpq reads none", () => {
		expect(passwordOf("postgres://app@db/app?passfile=/nowhere/pgpass")).toBe("")
	})

	it("refuses a file others can read, naming passfile, as libpq ignores one", () => {
		const file = passfile("*:*:*:*:open\n", 0o644)
		expect(() => postgresOptionsOf(`postgres://app@db/app?passfile=${file}`, "url")).toThrow(
			`passfile ${file} can be read by others, so libpq ignores it; chmod 600 it`,
		)
	})
})
