/**
 * A reader of comb's published field keys that knows only what meta-contract §2.1 defines, as a
 * client, form generator or gateway in another language would implement them. Tests hold comb's own
 * parse to it: whatever comb publishes, a reader applying the keys as written must reach the same
 * verdict (C1, C2 of r22).
 */
import { isCidr } from "../cidr.ts"
import { isStorableText } from "../storable-text.ts"

/** Each `x-comb-transform` value as §2.1 defines it */
export const CONTRACT_TRANSFORMS: Record<string, (value: string) => string> = {
	lowercase: (value) => value.toLowerCase(),
	nfc: (value) => value.normalize("NFC"),
	"strip-tab-newline": (value) => value.replace(/[\t\n\r]/g, ""),
	trim: (value) => value.trim(),
	uppercase: (value) => value.toUpperCase(),
}

/** The keys a read states without enforcing them, which a reader shows and never applies */
const STATED = ["x-comb-maxLength", "x-comb-maximum", "x-comb-minLength", "x-comb-minimum"]

/** Every field key the reader knows */
export const CONTRACT_KEYS: readonly string[] = [
	...STATED,
	"x-comb-cidr",
	"x-comb-maxBytes",
	"x-comb-maxUtf8Bytes",
	"x-comb-rectangular",
	"x-comb-text",
	"x-comb-transform",
	"x-comb-url",
]

const utf8 = (value: string): number => new TextEncoder().encode(value).length

/** Whether every sub-array of each level of `value`, across the whole level, has one length */
function isRectangular(value: unknown[]): boolean {
	let level: unknown[] = value
	while (level.some((part) => Array.isArray(part))) {
		if (!level.every((part) => Array.isArray(part))) return false
		if (new Set(level.map((part) => (part as unknown[]).length)).size > 1) return false
		level = level.flat()
	}
	return true
}

type Schema = Record<string, unknown>

/** Whether `value` as sent, before any rewrite, keeps to the keys that bind its JSON text and its shape */
function takesSent(schema: Schema, value: unknown): boolean {
	const jsonBytes = schema["x-comb-maxBytes"]
	if (typeof jsonBytes === "number" && utf8(JSON.stringify(value)) > jsonBytes) return false
	return schema["x-comb-rectangular"] === undefined || !Array.isArray(value) || isRectangular(value)
}

/** Whether a string `value` keeps to the keys and bounds that bind it, its transforms applied first */
function takesText(schema: Schema, value: string): boolean {
	if (schema["x-comb-cidr"] !== undefined && !isCidr(value)) return false
	const rewritten = ((schema["x-comb-transform"] ?? []) as string[]).reduce((text, name) => {
		const transform = CONTRACT_TRANSFORMS[name]
		if (transform === undefined) throw new Error(`the contract defines no transform ${name}`)
		return transform(text)
	}, value)
	return (schema["x-comb-url"] === undefined || URL.canParse(rewritten)) && takesRewritten(schema, rewritten)
}

/** Whether a string, its transforms applied, keeps to the keys and bounds that bind the stored value */
function takesRewritten(schema: Schema, rewritten: string): boolean {
	const points = [...rewritten].length
	if (schema["x-comb-text"] !== undefined && !isStorableText(rewritten)) return false
	if (typeof schema["minLength"] === "number" && points < schema["minLength"]) return false
	if (typeof schema["maxLength"] === "number" && points > schema["maxLength"]) return false
	const textBytes = schema["x-comb-maxUtf8Bytes"]
	return typeof textBytes !== "number" || utf8(rewritten) <= textBytes
}

/**
 * Whether a reader of the published `schema` takes `value`, applying its length bounds and its
 * `x-comb-*` keys as §2.1 defines them; a key it does not know throws, as a strict reader refuses one
 */
export function contractReader(schema: Schema, value: unknown): boolean {
	for (const key of Object.keys(schema))
		if (key.startsWith("x-comb-") && !CONTRACT_KEYS.includes(key)) throw new Error(`the contract defines no ${key}`)
	return takesSent(schema, value) && (typeof value !== "string" || takesText(schema, value))
}
