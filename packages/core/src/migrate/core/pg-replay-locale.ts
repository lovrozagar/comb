/**
 * The locale the replay's database is made at (PR4 of r22b): the target database's encoding, locale
 * provider, collation and character type, and its ICU or builtin locale and ICU rules. They decide a
 * text range partition's bounds, a CHECK on text order or bytes, a unique index on text and which
 * characters a seed may hold, so a replay at template0's, the server's default, could check a file
 * apply refuses on the target, or refuse one apply runs. They are read once from `url`'s pg_database,
 * whatever its version names them, and a devUrl server that cannot make them refuses the check,
 * naming them, as a verdict under another locale is not the target's.
 */
import type { PgTarget } from "./atlas-target.ts"
import { type Connect, failureOf } from "./pg-live-objects.ts"
import { literal, type Sql } from "./pg-replay-database.ts"
import { postgresOptionsOf } from "./pg-url.ts"
import { ReplayFailed } from "./replay-failed.ts"

/** A database's encoding and locale; `locale` is its ICU or builtin locale, `provider` its pg_database code */
type Locale = {
	collate: string
	ctype: string
	encoding: string
	locale: string | null
	provider: string | null
	rules: string | null
}

/*
 * the current database's locale, by its row as JSON, as Postgres 15 adds the provider and the ICU
 * locale, 16 the ICU rules, and 17 renames the ICU locale datlocale for the builtin provider too
 */
const LOCALE =
	"SELECT pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collate, d.datctype AS ctype, j->>'datlocprovider' AS provider, coalesce(j->>'datlocale', j->>'daticulocale') AS locale, j->>'daticurules' AS rules FROM pg_database d CROSS JOIN LATERAL to_jsonb(d) j WHERE d.datname = current_database()"

/* the first Postgres that makes a database with a locale provider of its own, rather than template0's */
const PROVIDERS = 150_000

/** `target`'s database's locale, read on `url`; one url refuses to give stops the run, naming url */
async function targetLocale(connect: Connect, target: PgTarget, stops: string): Promise<Locale> {
	const sql: Sql = connect({ ...postgresOptionsOf(target.url, "url"), max: 1, onnotice: () => undefined })
	try {
		const [row] = await sql.unsafe(LOCALE, [])
		return row as Locale
	} catch (error) {
		const failed = { field: "url", url: target.url, urls: [target.url, target.devUrl] } as const
		throw new ReplayFailed(
			`comb could not read the target database's locale on url, which the replay's database takes: ${failureOf(error, failed)}; ${stops}`,
			{ cause: error },
		)
	} finally {
		await sql.end()
	}
}

/**
 * The provider's clause: ICU's or builtin's with its locale, which Postgres sets for either, else
 * libc's, which a server since Postgres 15 is told, as its template0 may be ICU's
 */
function providerClause({ locale, provider, rules }: Locale, devVersion: number): string {
	if (provider === "i") {
		const ruled = rules === null ? "" : ` ICU_RULES ${literal(rules)}`
		return ` LOCALE_PROVIDER icu ICU_LOCALE ${literal(locale as string)}${ruled}`
	}
	if (provider === "b") return ` LOCALE_PROVIDER builtin BUILTIN_LOCALE ${literal(locale as string)}`
	return devVersion >= PROVIDERS ? " LOCALE_PROVIDER libc" : ""
}

/** CREATE DATABASE's options that make a database at `locale` on a server of `devVersion` */
const localeClause = (locale: Locale, devVersion: number): string =>
	`ENCODING ${literal(locale.encoding)} LC_COLLATE ${literal(locale.collate)} LC_CTYPE ${literal(locale.ctype)}${providerClause(locale, devVersion)}`

export { type Locale, localeClause, targetLocale }
