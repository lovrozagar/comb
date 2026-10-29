import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { libpqUrl, postgresOptionsOf, queryParams, withParam } from "./pg-url.ts"

/* P3, P4, P14 and P19 of the 0.14.1 review: a Postgres URL as libpq reads it */
describe("libpqUrl", () => {
	it("reads the userinfo, host, port and database, libpq's query keys over the URI's parts", () => {
		expect(libpqUrl("postgresql://a%40b:p%3Aw:x@db.example.com:6000/app?sslmode=require")).toMatchObject({
			database: "app",
			host: "db.example.com",
			password: "p:w:x",
			port: 6000,
			socket: false,
			user: "a@b",
		})
		expect(libpqUrl("postgres://u:p@h/d?host=other&port=7000&dbname=e&user=v&password=q")).toMatchObject({
			database: "e",
			host: "other",
			password: "q",
			port: 7000,
			user: "v",
		})
	})

	it("reads an IPv6 address in brackets, a socket's directory, and an empty host as localhost, as Atlas does", () => {
		expect(libpqUrl("postgres://[::1]:5433/app")).toMatchObject({ host: "::1", port: 5433, socket: false })
		expect(libpqUrl("postgres://u@%2Frun%2Fpg/app")).toMatchObject({ host: "/run/pg", socket: true })
		expect(libpqUrl("postgres:///app")).toMatchObject({ database: "app", host: "localhost", port: 5432 })
	})

	it("names the user's database when the URL names none, and leaves a password it does not give unset", () => {
		expect(libpqUrl("postgres://app@db")).toMatchObject({ database: "app", password: undefined })
	})

	it("cannot read a fragment, a port that is no number, a bad percent-escape, or another scheme", () => {
		for (const raw of [
			"postgres://db/app#x",
			"postgres://db:5x/app",
			"postgres://db/app?port=abc",
			"postgres://u:Zq%A7X@db/app",
			"postgres://d[b/app",
			"mysql://db/app",
		])
			expect(libpqUrl(raw), raw).toBeUndefined()
	})
})

describe("queryParams and withParam", () => {
	it("decodes each key and value, keeps a + as written, and reads a key with no value as empty", () => {
		expect([...queryParams("postgres://db/app?a=1+2&options=-c%20x%3D1&flag&&b=")]).toEqual([
			["a", "1+2"],
			["options", "-c x=1"],
			["flag", ""],
			["b", ""],
		])
		expect(queryParams("postgres://db/app").size).toBe(0)
	})

	it("sets a key once, removes one, and leaves the rest as written", () => {
		expect(withParam("postgres://db/app?a=1&b=2", "a", "x y")).toBe("postgres://db/app?b=2&a=x%20y")
		expect(withParam("postgres://db/app?search_path=s", "search_path")).toBe("postgres://db/app")
		expect(withParam("postgres://db/app", "b", "1")).toBe("postgres://db/app?b=1")
	})
})

/** postgres.js's `ssl` for a URL with `query` */
const ssl = (query: string) => postgresOptionsOf(`postgres://db/app${query}`, "url")["ssl"]

describe("postgresOptionsOf", () => {
	const dir = mkdtempSync(join(tmpdir(), "comb-pg-url-"))
	writeFileSync(join(dir, "root.crt"), "ROOT")

	it("maps libpq's sslmode as libpq connects: prefer unnamed, require checking a root certificate it is given", () => {
		expect(ssl("")).toBe("prefer")
		expect(ssl("?sslmode=allow")).toBe("prefer")
		expect(ssl("?sslmode=require")).toBe("require")
		const pinned = ssl(`?sslmode=require&sslrootcert=${join(dir, "root.crt")}`) as Record<string, unknown>
		expect(pinned).toEqual({ ca: "ROOT", checkServerIdentity: expect.any(Function), rejectUnauthorized: true })
		/* verify-ca checks the certificate's chain and not its host name */
		expect((pinned["checkServerIdentity"] as () => unknown)()).toBeUndefined()
	})

	it("refuses an sslmode libpq does not take, and a URL libpq cannot read, by the field's name", () => {
		expect(() => postgresOptionsOf("postgres://db/app?sslmode=verify_full", "url")).toThrow(
			"sslmode verify_full is none libpq takes: disable, allow, prefer, require, verify-ca or verify-full",
		)
		expect(() => postgresOptionsOf("postgres://u:Zq%A7X@db/app", "devUrl")).toThrow(
			"devUrl is not a postgres:// URL libpq can read",
		)
	})
})
