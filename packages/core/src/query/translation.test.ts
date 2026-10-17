import { describe, expect, it } from "vitest"
import { resolveTranslation } from "./translation.ts"

describe("resolveTranslation", () => {
	const translations = [
		{ languageCode: "en", name: "Hello", title: "World" },
		{ languageCode: "de", name: "Hallo", title: "Welt" },
		{ languageCode: "fr", name: "Bonjour", title: "Monde" },
	]

	it("returns exact language match", () => {
		const result = resolveTranslation({
			defaultLang: "en",
			fields: null,
			lang: "de",
			translations,
		})
		expect(result?.name).toBe("Hallo")
		expect(result?.title).toBe("Welt")
	})

	it("falls back to default language", () => {
		const result = resolveTranslation({
			defaultLang: "en",
			fields: null,
			lang: "ja",
			translations,
		})
		expect(result?.name).toBe("Hello")
	})

	it("falls back to first translation if no match", () => {
		const result = resolveTranslation({
			defaultLang: "ja",
			fields: null,
			lang: "ko",
			translations,
		})
		expect(result?.name).toBe("Hello")
	})

	it("returns null for empty translations", () => {
		expect(
			resolveTranslation({
				defaultLang: "en",
				fields: null,
				lang: "en",
				translations: [],
			}),
		).toBeNull()
	})

	it("filters by fields when provided", () => {
		const result = resolveTranslation({
			defaultLang: "en",
			fields: ["name"],
			lang: "en",
			translations,
		})
		expect(result?.name).toBe("Hello")
		expect(result?.title).toBeUndefined()
	})

	it("is case-insensitive for language codes", () => {
		const result = resolveTranslation({
			defaultLang: "EN",
			fields: null,
			lang: "DE",
			translations,
		})
		expect(result?.name).toBe("Hallo")
	})

	it("sets languageCode to requested lang", () => {
		const result = resolveTranslation({
			defaultLang: "en",
			fields: null,
			lang: "de",
			translations,
		})
		expect(result?.languageCode).toBe("de")
	})

	it("uses custom languageCodeKey", () => {
		const customTranslations = [
			{ lang: "en", name: "Hello" },
			{ lang: "de", name: "Hallo" },
		]
		const result = resolveTranslation({
			defaultLang: "en",
			fields: null,
			lang: "de",
			languageCodeKey: "lang",
			translations: customTranslations,
		})
		expect(result?.name).toBe("Hallo")
	})

	it("keeps a missing field missing rather than filling it from another language", () => {
		const partial = [
			{ languageCode: "en", name: "Hello", title: "World" },
			{ languageCode: "de", name: "Hallo", title: undefined },
		]
		const result = resolveTranslation({ defaultLang: "en", fields: null, lang: "de", translations: partial })
		expect(result).toEqual({ languageCode: "de", name: "Hallo", title: undefined })
	})
})

describe("resolveTranslation — the language it reports (Q-L5)", () => {
	const en = { body: "English body", languageCode: "en", title: "Hello" }

	it("labels fallback content with the language it is in, not the one requested", () => {
		expect(resolveTranslation({ defaultLang: "en", fields: null, lang: "fr", translations: [en] })).toEqual(en)
	})

	it("returns one row's fields, never a mix of languages under one label", () => {
		const de = { body: null, languageCode: "de", title: "Hallo" }
		expect(resolveTranslation({ defaultLang: "en", fields: null, lang: "de", translations: [en, de] })).toEqual(de)
	})
})
