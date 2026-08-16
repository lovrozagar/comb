/**
 * Shared regex patterns for table field constraints.
 * Used as `pattern` values in c.text() definitions.
 *
 * These are source-level strings read by the codegen parser —
 * backslashes are doubled so the generated .regex() output is correct.
 */
const patterns = {
	/** ISO 3166-1 alpha-2 country code (e.g. "US", "DE") */
	COUNTRY_ALPHA2: "/^[A-Z]{2}$/",
	/** E.164 international phone number (e.g. "+14155552671") */
	E164_PHONE: "/^\\+[1-9]\\d{7,14}$/",
	/** IANA timezone (e.g. "America/New_York", "Europe/Berlin") */
	IANA_TIMEZONE: "/^[A-Za-z_/]+$/",
	/** BCP 47 language tag, base or with region (e.g. "en", "pt-BR") */
	LOCALE: "/^[a-z]{2}(-[A-Z]{2})?$/",
} as const

export { patterns }
