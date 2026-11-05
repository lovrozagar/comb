/**
 * Multi-language translation resolution — zero deps.
 * Picks one translation row by language code: the requested one, else the default, else the first.
 */

/** What resolveTranslation picks a translation row from; language codes compare ignoring case */
type TranslationResolverInput<T extends Record<string, unknown>> = {
	/** the language whose row stands in where `lang` has none */
	defaultLang: string
	/** the keys to keep from the picked row; null keeps every key */
	fields: string[] | null
	/** the requested language, such as a parsed `lang` param */
	lang: string
	/** the key each row holds its language code under; default `languageCode` */
	languageCodeKey?: string | undefined
	/** one row per language */
	translations: T[]
}

/**
 * The one row of `translations` in `lang`, else in `defaultLang`, else the first, cut to `fields`.
 * Null when there are no rows. Fields are never mixed across rows, so a value is always in its row's language
 */
function resolveTranslation<T extends Record<string, unknown>>(input: TranslationResolverInput<T>): Partial<T> | null {
	const { defaultLang, fields, lang, languageCodeKey = "languageCode", translations } = input

	if (!translations || translations.length === 0) {
		return null
	}

	const langLower = lang.toLowerCase()
	const defaultLangLower = defaultLang.toLowerCase()

	const requested = translations.find((t) => String(t[languageCodeKey]).toLowerCase() === langLower)
	const fallback = translations.find((t) => String(t[languageCodeKey]).toLowerCase() === defaultLangLower)

	/* one row, under its own language code: mixing rows would label one language's text as another's */
	/* the list is non-empty, checked above */
	const primary = requested ?? fallback ?? (translations[0] as T)
	const keys = Object.keys(primary).filter((key) => fields === null || fields.includes(key))
	return Object.fromEntries(keys.map((key) => [key, primary[key]])) as Partial<T>
}

export { resolveTranslation, type TranslationResolverInput }
