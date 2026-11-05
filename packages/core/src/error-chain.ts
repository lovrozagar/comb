/**
 * An error and the ones under it on `.cause`, past wrappers such as drizzle's DrizzleQueryError,
 * which keeps the engine's own words only on its cause: the one walk every classifier that reads a
 * driver's error takes, outermost first and at most MAX_DEPTH deep, as a cause chain a
 * driver builds is never deeper.
 */

/* how deep a chain is read: past every wrapper comb meets, and short of any cycle */
const MAX_DEPTH = 8

/** `error` and each object under it on `.cause`, outermost first */
function causeChain(error: unknown): object[] {
	const chain: object[] = []
	for (let link = error; chain.length < MAX_DEPTH && typeof link === "object" && link !== null;) {
		chain.push(link)
		link = (link as { cause?: unknown }).cause
	}
	return chain
}

/**
 * `chain`, a cause chain or a mapping of one, innermost first: the deepest link is the driver's or
 * the engine's own error. Built by a loop, not `toReversed`, as the runtime subpaths keep to lib
 * ES2022
 */
function innermostFirst<T>(chain: readonly T[]): T[] {
	const reversed: T[] = []
	for (const link of chain) reversed.unshift(link)
	return reversed
}

/** The texts a classifier reads from `error`: each link's message and string code, outermost first; a thrown string as itself */
function errorTexts(error: unknown): string[] {
	if (typeof error === "string") return [error]
	return causeChain(error).flatMap((link) => {
		const { code, message } = link as { code?: unknown; message?: unknown }
		return [message, code].filter((text): text is string => typeof text === "string")
	})
}

/** `error`'s message and each under it on `.cause`, as `fetch failed: read ECONNRESET` */
const chainText = (error: unknown): string =>
	causeChain(error)
		.map((link) => (link as { message?: unknown }).message)
		.filter((message): message is string => typeof message === "string" && message !== "")
		.join(": ")

export { causeChain, chainText, errorTexts, innermostFirst }
