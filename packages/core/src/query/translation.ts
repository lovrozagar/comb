/**
 * Multi-language translation resolution — zero deps.
 * Picks best translation from array by language code with fallback chain.
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

	const primary = requested ?? fallback ?? translations[0]
	if (!primary) return null

	const include = (field: string) => fields === null || fields.includes(field)

	const result: Record<string, unknown> = {}

	for (const key of Object.keys(primary)) {
		if (!include(key)) continue

		if (key === languageCodeKey) {
			result[key] = lang
		} else {
			const value = requested?.[key] ?? fallback?.[key] ?? primary[key]
			result[key] = value
		}
	}

	return result as Partial<T>
}

export { resolveTranslation, type TranslationResolverInput }
