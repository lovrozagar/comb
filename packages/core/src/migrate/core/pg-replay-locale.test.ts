import { describe, expect, it } from "vitest"
import { coded, fake } from "../__fixtures__/pg-admin.ts"
import type { Connect } from "./pg-live-objects.ts"
import { type Locale, localeClause, targetLocale } from "./pg-replay-locale.ts"
import { ReplayFailed } from "./replay-failed.ts"

const TARGET = {
	devUrl: "postgres://dev/dev",
	lockTimeout: "5s",
	schema: "public",
	url: "postgres://app:secret@app/app",
}
const LIBC: Locale = {
	collate: "en_US.UTF-8",
	ctype: "en_US.UTF-8",
	encoding: "UTF8",
	locale: null,
	provider: "c",
	rules: null,
}

describe("targetLocale", () => {
	it("reads the locale of url's database, by its row as JSON whatever the version names it, on a connection it closes", async () => {
		const url = fake(() => [LIBC])
		const given: Array<Record<string, unknown>> = []
		const connect = ((options: Record<string, unknown>) => (given.push(options), url.sql)) as unknown as Connect
		expect(await targetLocale(connect, TARGET, "check applies nothing")).toEqual(LIBC)
		expect(url.sent).toEqual([expect.stringMatching(/to_jsonb\(d\) j WHERE d\.datname = current_database\(\)$/)])
		expect(given[0]).toMatchObject({ database: "app", host: "app", max: 1 })
	})

	it("stops the run, naming url and masking its password, where url refuses the read", async () => {
		const url = fake(() => coded("28P01", 'password "secret" authentication failed for user "app"'))
		const connect = (() => url.sql) as unknown as Connect
		const read = targetLocale(connect, TARGET, "check applies nothing")
		await expect(read).rejects.toThrow(ReplayFailed)
		await expect(read).rejects.toThrow(
			/^comb could not read the target database's locale on url, which the replay's database takes: .*authentication failed .*; check applies nothing$/,
		)
		await expect(read).rejects.not.toThrow("secret")
	})
})

describe("localeClause", () => {
	it.each([
		{
			clause: "ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' LOCALE_PROVIDER libc",
			locale: LIBC,
			name: "libc on a server since Postgres 15, told so as template0 may be ICU's",
			version: 150000,
		},
		{
			clause: "ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8'",
			locale: { ...LIBC, provider: null },
			name: "libc, a target before Postgres 15 naming no provider, on a server before it",
			version: 140000,
		},
		{
			clause: "ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' LOCALE_PROVIDER icu ICU_LOCALE 'en-US'",
			locale: { ...LIBC, locale: "en-US", provider: "i" },
			name: "ICU with no rules",
			version: 160000,
		},
		{
			clause:
				"ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' LOCALE_PROVIDER icu ICU_LOCALE 'en-US' ICU_RULES '&N < ''a'''",
			locale: { ...LIBC, locale: "en-US", provider: "i", rules: "&N < 'a'" },
			name: "ICU with rules quoted",
			version: 170000,
		},
		{
			clause: "ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'",
			locale: { ...LIBC, collate: "C", ctype: "C", locale: "C.UTF-8", provider: "b" },
			name: "builtin",
			version: 170000,
		},
	])("makes $name", ({ clause, locale, version }) => {
		expect(localeClause(locale, version)).toBe(clause)
	})
})
