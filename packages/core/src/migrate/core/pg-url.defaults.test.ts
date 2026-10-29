/**
 * P6 and P7 of the 0.15.0 review: a Postgres URL read as libpq reads what it leaves out, and the
 * libpq keys Atlas takes that comb's own reads refused or ignored.
 * - P6: a URL with no user is libpq's OS user, and its database that user's, never PGUSER's or
 *   PGDATABASE's, which Atlas's environment never holds; a password comes from the URL alone.
 * - P7: fallback_application_name sets application_name when the URL has none, and is no server
 *   setting; hostaddr is the address comb connects to, host the TLS server name, as libpq has them.
 */
import { userInfo } from "node:os"
import { describe, expect, it } from "vitest"
import { pgUrlProblems } from "./atlas-target.ts"
import { libpqUrl, postgresOptionsOf } from "./pg-url.ts"

const OS_USER = userInfo().username

describe("libpqUrl on a URL that leaves out the user", () => {
	it("reads libpq's OS user, and that user's database", () => {
		expect(libpqUrl("postgres://db")).toMatchObject({ database: OS_USER, user: OS_USER })
		expect(libpqUrl("postgres:///app")).toMatchObject({ database: "app", user: OS_USER })
	})

	it("counts a URL with no user and one naming the OS user's database as one database", () => {
		const problems = pgUrlProblems({
			devUrl: "postgres://localhost:55432",
			lockTimeout: "5s",
			schema: "public",
			url: `postgres://localhost:55432/${OS_USER}`,
		})
		expect(problems.errors).toContain(
			"url and devUrl are the same database; Atlas empties the dev database, so give it its own",
		)
	})
})

describe("postgresOptionsOf: what postgres.js would fill from the environment", () => {
	it("names the user and the database itself, and a password only from the URL", async () => {
		const options = postgresOptionsOf("postgres://db", "url")
		expect(options).toMatchObject({ database: OS_USER, host: "db", port: 5432, username: OS_USER })
		/* postgres.js reads PGPASSWORD for a password it is not given; a function it calls instead */
		expect(await (options["password"] as () => Promise<string> | string)()).toBe("")
		expect(postgresOptionsOf("postgres://u:pw@db/app", "url")["password"]).toBe("pw")
	})
})

describe("postgresOptionsOf: libpq's client keys", () => {
	it("sets application_name from fallback_application_name when the URL has none, and sends neither key on as a setting otherwise", () => {
		expect(postgresOptionsOf("postgres://u@db/app?fallback_application_name=myapp", "url")["connection"]).toEqual({
			application_name: "myapp",
		})
		expect(
			postgresOptionsOf("postgres://u@db/app?application_name=mine&fallback_application_name=myapp", "url")[
				"connection"
			],
		).toEqual({ application_name: "mine" })
	})

	it("connects to hostaddr, keeping host as the server name TLS checks", () => {
		expect(postgresOptionsOf("postgres://u@db.invalid/app?hostaddr=127.0.0.1&sslmode=disable", "url")).toMatchObject({
			host: "127.0.0.1",
		})
		expect(
			postgresOptionsOf("postgres://u@db.example.com/app?hostaddr=10.0.0.5&sslmode=verify-full", "url"),
		).toMatchObject({ host: "10.0.0.5", ssl: { rejectUnauthorized: true, servername: "db.example.com" } })
	})

	it("counts the address hostaddr names when it tells two databases apart", () => {
		const problems = pgUrlProblems({
			devUrl: "postgres://u@localhost/app?sslmode=disable",
			lockTimeout: "5s",
			schema: "public",
			url: "postgres://u@db.invalid/app?hostaddr=127.0.0.1&sslmode=disable",
		})
		expect(problems.errors).toContain(
			"url and devUrl are the same database; Atlas empties the dev database, so give it its own",
		)
	})
})
