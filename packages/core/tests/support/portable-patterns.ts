/**
 * Declared patterns comb takes, each one rule under ECMAScript on every Node comb supports, Go's
 * RE2 and Rust's regex. `src/codegen/utils/pattern.grammar.test.ts` takes each, and the consumers
 * job compiles each on Node's floor, so a construct only a newer ECMAScript reads fails there.
 */
export const PORTABLE_PATTERNS: readonly string[] = [
	"/^a{0}$/u",
	"/^(?:a{2}){500}$/u",
	"/^(?:(?:a{10}){10}){10}$/u",
	"/^(?:a{0}){1000}b{1000}$/u",
	"/^(?<_a1>a)(?<B2>b)(c)(?:d)$/u",
	"/^a{2,}?b{0,3}?c*?d+?e??$/u",
	"/^(?:)|a|()$/u",
	"/^\\p{L}{80}$/u",
	"/^[\\p{L}\\p{N} '-]+$/u",
	"/^[^\\p{Cc}\\p{Cf}]{1,64}$/u",
	"/^\\P{Nd}[\\x00-\\x1F]\\t\\n\\r\\f\\v$/u",
	"/^[é😀]{10}€𐀀$/u",
	"/^é\\P{Cn}[^\\x00-\\x1F]$/u",
]
