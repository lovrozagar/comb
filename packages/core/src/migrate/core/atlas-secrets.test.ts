import { describe, expect, it } from "vitest"
import { redactUrl, scrubAtlasOutput } from "./atlas-secrets.ts"

describe("redactUrl and scrubAtlasOutput", () => {
	it("masks the password and secret query values, and an unparseable URL whole", () => {
		expect(redactUrl("postgres://app:S3cret@db/app?sslmode=require&password=Q1&api_token=T")).toBe(
			"postgres://app:***@db/app?sslmode=require&password=***&api_token=***",
		)
		expect(redactUrl("postgres://app:ab#cd@db")).toBe("<redacted url>")
		expect(redactUrl("postgres://localhost/app?sslmode=disable")).toBe("postgres://localhost/app?sslmode=disable")
	})

	it("scrubs every form a secret takes in Atlas's output", () => {
		const url = "postgres://app:p%40ss@db/app?sslpassword=Q1"
		const text = [
			`dial ${url}`,
			'"RawQuery":"sslpassword=Q1"',
			"password p@ss rejected",
			"postgres://other:Other1@host/x",
		].join("\n")
		const out = scrubAtlasOutput(text, [url])
		expect(out).not.toMatch(/p%40ss|p@ss|Q1|Other1/)
		expect(out).toContain("postgres://other:***@host/x")
	})

	/* M79: the generic rule masks free text's `key=value`, never a JSON key that names a key */
	it("leaves Atlas's JSON whole, its primary_key and foreign_keys among it, and masks a key=value in free text", () => {
		const json =
			'{"tables":[{"name":"a","columns":[{"name":"api_token"}],"primary_key":{"parts":[]},"foreign_keys":[]}]}'
		expect(scrubAtlasOutput(json, ["postgres://app:S3cret@db/app"])).toBe(json)
		expect(scrubAtlasOutput("dial with api_key=K9 and ?password=P1&x=1", [])).toBe(
			"dial with api_key=*** and ?password=***&x=1",
		)
	})

	it("masks a URL that does not parse as the whole string", () => {
		const raw = "postgres://app:ab#cd@db/app"
		expect(scrubAtlasOutput(`parse open url ${raw}: invalid port`, [raw])).toBe("parse open url ***: invalid port")
		expect(scrubAtlasOutput("open not-a-url: refused", ["not-a-url"])).toBe("open ***: refused")
	})
})

describe("a secret holding a percent sign", () => {
	const url = "postgres://app@db.example.com/app?sslmode=require&sslpassword=50%25off"

	it("is masked in Atlas's output, in the query and in userinfo, without throwing", () => {
		expect(scrubAtlasOutput("failed with sslpassword 50%off and 50%25off", [url])).toBe(
			"failed with sslpassword *** and ***",
		)
		const odd = "postgres://app:a%zz@db.example.com/app?sslmode=require"
		expect(scrubAtlasOutput("auth a%zz failed", [odd])).toBe("auth *** failed")
	})
})

/* P5 and P18 of the 0.14.1 review, and the socket targets libpq and Atlas take (P14) */
describe("the secrets of a URL WHATWG's URL cannot decode or read", () => {
	it("scrubs a password whose escape decodes to no UTF-8, without throwing", () => {
		const url = "postgres://app:Zq%A7X9secret@db.example.com/app?sslmode=require"
		expect(scrubAtlasOutput("auth Zq%A7X9secret failed", [url])).toBe("auth *** failed")
	})

	it("masks a socket target's password, which WHATWG's URL refuses with its host empty", () => {
		const url = "postgres://app:Sock3t%2Fpw@/app?host=/run/postgresql&sslpassword=K1"
		expect(scrubAtlasOutput("password Sock3t/pw rejected; sslpassword K1", [url])).toBe(
			"password *** rejected; sslpassword ***",
		)
	})

	it("masks a password where it stands as a token, and leaves it inside a longer name", () => {
		const url = "postgres://comb:comb@db.example.com/comb?sslmode=require"
		expect(scrubAtlasOutput('relation "comb_jobs" does not exist (database comb)', [url])).toBe(
			'relation "comb_jobs" does not exist (database ***)',
		)
	})
})
