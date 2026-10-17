/**
 * Multi-language translation resolution — zero deps.
 * Picks one translation row by language code: the requested one, else the default, else the first.
 */

type TranslationResolverInput<T extends Record<string, unknown>> = {
	defaultLang: string
	fields: string[] | null
	lang: string
	languageCodeKey?: string
	translations: T[]
}

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
