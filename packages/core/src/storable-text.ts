/**
 * Text every engine stores as sent. No engine does with U+0000 or a lone UTF-16 surrogate: jsonb
 * refuses both, Postgres text refuses U+0000 and takes a lone surrogate as U+FFFD, libsql cuts at
 * U+0000, and bun:sqlite reads a lone surrogate back as other text (F11). Generated write DTOs hold
 * every text to it through `isStorableText`, so the rule has one source; `storableText()` gives an
 * app's own schema the same rule (G1). A refine, never a pattern: published as one, Go's and Rust's
 * engines refuse \u and a surrogate, and a field's own pattern would move into an allOf (F56).
 */
import * as z from "zod"

/* how JSON Schema names the rule, a refine it cannot publish as a pattern (F56) */
export const STORABLE_TEXT_RULE = "no U+0000 or unpaired surrogate"

/** Whether every engine stores `value` as sent: it holds no U+0000 and no lone surrogate */
export function isStorableText(value: string): boolean {
	/* by code point: a pair is one past U+FFFF, so only a lone half falls in the surrogate range */
	for (const char of value) {
		const point = char.codePointAt(0) as number
		if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) return false
	}
	return true
}

/** A string schema that refuses what `isStorableText` refuses, publishing the rule as `x-comb-text` */
export const storableText = (): z.ZodString =>
	z
		.string()
		.refine(isStorableText, { message: "Must not contain U+0000 or an unpaired surrogate" })
		.meta({ "x-comb-text": STORABLE_TEXT_RULE })
