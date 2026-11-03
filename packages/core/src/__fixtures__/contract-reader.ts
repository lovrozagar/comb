/**
 * A reader of comb's published field keys that knows only what meta-contract §2.1 defines, as a
 * client, form generator or gateway in another language would implement them. Tests hold comb's own
 * parse to it: whatever comb publishes, a reader applying the keys as written must reach the same
 * verdict (C1, C2 of r22).
 */
import { isStorableText } from "../storable-text.ts"

/** Each `x-comb-transform` value as §2.1 defines it */
export const CONTRACT_TRANSFORMS: Record<string, (value: string) => string> = {
	lowercase: (value) => value.toLowerCase(),
	nfc: (value) => value.normalize("NFC"),
	trim: (value) => value.trim(),
	uppercase: (value) => value.toUpperCase(),
}

/** The keys a read states without enforcing them, which a reader shows and never applies */
const STATED = ["x-comb-maxLength", "x-comb-maximum", "x-comb-minLength", "x-comb-minimum"]

/** Every field key the reader knows */
export const CONTRACT_KEYS: readonly string[] = [
	...STATED,
	"x-comb-maxBytes",
	"x-comb-maxUtf8Bytes",
	"x-comb-text",
	"x-comb-transform",
]

const utf8 = (value: string): number => new TextEncoder().encode(value).length

/**
 * Whether a reader of the published `schema` takes `value`, applying its length bounds and its
 * `x-comb-*` keys as §2.1 defines them; a key it does not know throws, as a strict reader refuses one
 */
export function contractReader(schema: Record<string, unknown>, value: unknown): boolean {
	for (const key of Object.keys(schema))
		if (key.startsWith("x-comb-") && !CONTRACT_KEYS.includes(key)) throw new Error(`the contract defines no ${key}`)
	/* the JSON text is the value as sent, before any rewrite */
	const jsonBytes = schema["x-comb-maxBytes"]
	if (typeof jsonBytes === "number" && utf8(JSON.stringify(value)) > jsonBytes) return false
	if (typeof value !== "string") return true
	const rewritten = ((schema["x-comb-transform"] ?? []) as string[]).reduce((text, name) => {
		const transform = CONTRACT_TRANSFORMS[name]
		if (transform === undefined) throw new Error(`the contract defines no transform ${name}`)
		return transform(text)
	}, value)
	const points = [...rewritten].length
	if (schema["x-comb-text"] !== undefined && !isStorableText(rewritten)) return false
	if (typeof schema["minLength"] === "number" && points < schema["minLength"]) return false
	if (typeof schema["maxLength"] === "number" && points > schema["maxLength"]) return false
	const textBytes = schema["x-comb-maxUtf8Bytes"]
	return typeof textBytes !== "number" || utf8(rewritten) <= textBytes
}
