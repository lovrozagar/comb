import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
	atlasUrls,
	explainAtlasFailure,
	pgUrlProblems,
	redactUrl,
	revisionsSchema,
	maskSecrets,
	scrubAtlasOutput,
	withAtlasEnv,
	type PgTarget,
} from "./atlas-target.ts"

const target = (over: Partial<PgTarget> = {}): PgTarget => ({
	devUrl: "docker://postgres/17/dev",
	lockTimeout: "5s",
	schema: "public",
	url: "postgres://app:S3cret@db.example.com:5432/app?sslmode=verify-full",
	...over,
})

describe("pgUrlProblems", () => {
	it("finds nothing wrong with a direct, verified remote URL", () => {
		expect(pgUrlProblems(target())).toEqual({ errors: [], warnings: [] })
	})

	it("names the field of a bad URL without its value", () => {
		for (const url of ["postgres://app:ab#cd@db/app", "postgres://app:ab/cd@db/app", "mysql://db/app", "not a url"]) {
			const { errors } = pgUrlProblems(target({ url }))
			expect(errors).toEqual([
				"url is not a postgres:// URL; percent-encode special characters (#, /, ?, @) in the password",
			])
			expect(errors.join()).not.toMatch(/ab|cd|mysql/)
		}
		expect(pgUrlProblems(target({ devUrl: "http://x" })).errors).toEqual([
			"devUrl is not a postgres:// or docker:// URL; percent-encode special characters (#, /, ?, @) in the password",
		])
	})

	it("refuses an empty URL, and a dev database that is the target", () => {
		expect(pgUrlProblems(target({ url: "" })).errors).toEqual(["url is empty"])
		expect(pgUrlProblems(target({ devUrl: " " })).errors).toEqual(["devUrl is empty"])
		const same = "postgres://localhost/app?sslmode=disable"
		expect(pgUrlProblems(target({ devUrl: same, url: same })).errors).toEqual([
			"url and devUrl are the same database; Atlas empties the dev database, so give it its own",
		])
	})

	it("refuses a schema that is not a plain name, and a lock timeout it cannot pass on", () => {
		expect(pgUrlProblems(target({ schema: "public;drop" })).errors).toEqual([
			'schema must be a plain name such as "public"',
		])
		expect(pgUrlProblems(target({ lockTimeout: "soon" })).errors).toEqual([
			"lockTimeout must look like 5s, 1500ms, 1min or 0",
		])
		expect(pgUrlProblems(target({ lockTimeout: "1500ms" })).errors).toEqual([])
	})

	it("warns of a remote host that does not verify TLS, and of poolers", () => {
		const host = "postgres://app:pw@db.example.com/app"
		expect(pgUrlProblems(target({ url: host })).warnings).toEqual([
			"url reaches db.example.com without sslmode=verify-full or require, so the password may cross the network unencrypted or to an unverified server",
		])
		expect(pgUrlProblems(target({ url: `${host}?sslmode=prefer` })).warnings).toHaveLength(1)
		expect(pgUrlProblems(target({ url: `${host}?sslmode=require` })).warnings).toEqual([])
		expect(pgUrlProblems(target({ url: "postgres://localhost/app" })).warnings).toEqual([])
		expect(
			pgUrlProblems(target({ url: "postgres://ep-x-pooler.eu.aws.neon.tech/app?sslmode=require" })).warnings,
		).toEqual([
			"url is a Neon pooled host; migrations need the direct one (drop -pooler), since a pooler drops the lock Atlas holds",
		])
		expect(
			pgUrlProblems(target({ url: "postgres://aws-0.pooler.supabase.com:6543/postgres?sslmode=require" })).warnings,
		).toEqual([
			"url uses port 6543, Supabase's transaction pooler; migrations need the direct or session connection on 5432",
		])
	})
})

describe("atlasUrls", () => {
	it("scopes both URLs to the schema and bounds the target's lock wait", () => {
		const urls = atlasUrls(target({ url: "postgres://localhost/app?sslmode=disable" }))
		expect(urls.url).toBe("postgres://localhost/app?sslmode=disable&search_path=public&options=-c+lock_timeout%3D5s")
		expect(urls.devUrl).toBe("docker://postgres/17/dev?search_path=public")
	})

	it("keeps a search_path, a lock_timeout and other options the user set, and sets none for 0", () => {
		const set = atlasUrls(
			target({ url: "postgres://localhost/app?search_path=app&options=-c%20statement_timeout%3D0" }),
		)
		expect(new URL(set.url).searchParams.get("search_path")).toBe("app")
		expect(new URL(set.url).searchParams.get("options")).toBe("-c statement_timeout=0 -c lock_timeout=5s")
		const own = atlasUrls(target({ url: "postgres://localhost/app?options=-c%20lock_timeout%3D1s" }))
		expect(new URL(own.url).searchParams.get("options")).toBe("-c lock_timeout=1s")
		const off = atlasUrls(target({ lockTimeout: "0", url: "postgres://localhost/app" }))
		expect(new URL(off.url).searchParams.has("options")).toBe(false)
	})
})

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
	})
})

describe("explainAtlasFailure", () => {
	it("says to set devUrl when Atlas cannot reach Docker for the default dev database", () => {
		expect(explainAtlasFailure("Error: docker: Cannot connect to the Docker daemon")).toBe(
			"Atlas needs Docker for the default devUrl (docker://postgres/17/dev); set devUrl to an empty Postgres database instead",
		)
		expect(explainAtlasFailure("Error: pq: relation missing")).toBe("Error: pq: relation missing")
	})

	it("says another migration is running when Atlas cannot take its lock", () => {
		expect(explainAtlasFailure("Error: acquiring database lock: sql/schema: lock is held by other session")).toBe(
			"another migrate apply is running on this database; run it again once that one finishes",
		)
	})

	it("says how to drop an enum value by hand, and what to do with an object Atlas OSS refuses", () => {
		expect(explainAtlasFailure('Error: dropping value "b" from enum "mood" is not supported')).toBe(
			'Atlas cannot drop the value "b" of enum "mood": write that migration by hand (a new type without it, the columns moved to it, the old type dropped), then run migrate diff again',
		)
		expect(explainAtlasFailure("Error: functions are available to logged-in users only. Use 'atlas login'")).toBe(
			"Atlas OSS does not diff functions: take them out of the drizzle schema and write their migration by hand, or use Atlas Pro",
		)
	})
})

describe("a secret holding a percent sign", () => {
	const url = "postgres://app@db.example.com/app?sslmode=require&sslpassword=50%25off"
	const percent: PgTarget = { devUrl: "postgres://localhost/dev", lockTimeout: "5s", schema: "public", url }

	it("is masked in Atlas's output, in the query and in userinfo, without throwing", () => {
		expect(scrubAtlasOutput("failed with sslpassword 50%off and 50%25off", [url])).toBe(
			"failed with sslpassword *** and ***",
		)
		const odd = "postgres://app:a%zz@db.example.com/app?sslmode=require"
		expect(scrubAtlasOutput("auth a%zz failed", [odd])).toBe("auth *** failed")
	})

	it("runs Atlas with the URL in its environment", () => {
		expect(withAtlasEnv(percent, { url: true }, (env) => env.env["COMB_ATLAS_URL"])).toContain("sslpassword=50%25off")
	})
})

describe("withAtlasEnv", () => {
	it("hands Atlas the URLs through env and a config that reads them, never through argv", () => {
		const seen = withAtlasEnv(target(), { dev: true, dir: "/m/core", url: true }, (atlas) => {
			const config = atlas.args[1] as string
			expect(atlas.args).toEqual(["--config", config, "--env", "comb"])
			expect(atlas.args.join(" ")).not.toContain("S3cret")
			const hcl = readFileSync(config.replace("file://", ""), "utf8")
			expect(hcl).toBe(`env "comb" {
  url = getenv("COMB_ATLAS_URL")
  dev = getenv("COMB_ATLAS_DEV_URL")
  migration {
    dir = "file:///m/core"
    revisions_schema = "atlas_schema_revisions"
  }
}
`)
			expect(atlas.env.COMB_ATLAS_URL).toContain("search_path=public")
			return atlas.dir
		})
		expect(existsSync(seen)).toBe(false)
	})

	it("sets only what the call needs, and escapes a directory HCL would interpolate", () => {
		withAtlasEnv(target(), { dir: '/m/${x}"q%{y}' }, (atlas) => {
			const hcl = readFileSync(`${atlas.dir}/atlas.hcl`, "utf8")
			expect(hcl).not.toMatch(/url =|dev =/)
			expect(hcl).toContain('dir = "file:///m/$${x}\\"q%%{y}"')
			expect(Object.keys(atlas.env)).toEqual([])
		})
	})

	it("removes its directory when the body fails, sync or async", async () => {
		let dir = ""
		expect(() =>
			withAtlasEnv(target(), { url: true }, (atlas) => {
				dir = atlas.dir
				throw new Error("boom")
			}),
		).toThrow("boom")
		expect(existsSync(dir)).toBe(false)
		await expect(
			withAtlasEnv(target(), { url: true }, async (atlas) => {
				dir = atlas.dir
				throw new Error("later")
			}),
		).rejects.toThrow("later")
		expect(existsSync(dir)).toBe(false)
	})

	it("refuses a target with problems before Atlas runs, and scrubs with the target's URLs", () => {
		expect(() => withAtlasEnv(target({ url: "" }), { url: true }, () => undefined)).toThrow("url is empty")
		const scrubbed = withAtlasEnv(target(), { url: true }, (atlas) => atlas.scrub("auth failed for S3cret"))
		expect(scrubbed).toBe("auth failed for ***")
		/* M79: maskSecrets takes the given URLs' secrets only, not the generic rules */
		expect(maskSecrets("auth failed for S3cret, api_key=x", [target().url])).toBe("auth failed for ***, api_key=x")
	})
})

/* M21 of the 0.12 round: two schemas of one database never share a history */
describe("revisionsSchema", () => {
	const base = "postgres://app@db.example.com/app"
	it("keeps public's history where it always was, and gives any other schema its own", () => {
		expect(revisionsSchema(target())).toBe("atlas_schema_revisions")
		expect(revisionsSchema(target({ schema: "tenant_a" }))).toBe("atlas_schema_revisions_tenant_a")
	})

	it("takes the configured schema, which a search_path in the url must name (M39)", () => {
		expect(revisionsSchema(target({ schema: "tenant_b", url: `${base}?search_path=tenant_b` }))).toBe(
			"atlas_schema_revisions_tenant_b",
		)
	})

	it("names a scope Postgres would cut or fold by its hash, so two never meet", () => {
		const long = (tail: string) => revisionsSchema(target({ schema: `${"t".repeat(40)}${tail}` }))
		expect(long("a")).toMatch(/^atlas_schema_revisions_[0-9a-f]{16}$/)
		expect(long("a")).not.toBe(long("b"))
		expect(revisionsSchema(target({ schema: "Tenant" }))).not.toBe(revisionsSchema(target({ schema: "tenant" })))
	})

	it("writes the target's history schema into the Atlas config", () => {
		withAtlasEnv(target({ schema: "tenant_a" }), { url: true }, (atlas) => {
			expect(readFileSync(`${atlas.dir}/atlas.hcl`, "utf8")).toContain(
				'revisions_schema = "atlas_schema_revisions_tenant_a"',
			)
		})
	})
})

/* M39 of the 0.13 review: comb migrates one schema, so the URL's own search_path must be that one */
describe("pgUrlProblems: a search_path in the url", () => {
	const base = "postgres://app@db.example.com/app"
	it.each([
		[
			"public,extensions",
			"public",
			"the url's search_path names more than one schema (public,extensions); comb migrates one: set schema to it, and drop search_path from the url",
		],
		[
			"tenant_b",
			"tenant_a",
			"the url's search_path names tenant_b, but schema is tenant_a; comb migrates one: set schema to it, and drop search_path from the url",
		],
	])("refuses search_path=%s with schema %s, naming both", (path, schema, error) => {
		expect(pgUrlProblems(target({ schema, url: `${base}?search_path=${encodeURIComponent(path)}` })).errors).toEqual([
			error,
		])
	})

	it("takes a search_path that names the configured schema", () => {
		expect(pgUrlProblems(target({ schema: "tenant_a", url: `${base}?search_path=tenant_a` })).errors).toEqual([])
	})
})
