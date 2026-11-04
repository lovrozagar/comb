/**
 * Runs `body` with `process.versions.bun` as `version`, none for undefined, whatever runtime runs
 * the test, so a branch on comb's runtime is tested both ways; restored when `body`, or the promise
 * it returns, ends
 */
export function onBun<T>(version: string | undefined, body: () => T): T {
	const own = Object.getOwnPropertyDescriptor(process.versions, "bun")
	const restore = () => {
		if (own === undefined) Reflect.deleteProperty(process.versions, "bun")
		else Object.defineProperty(process.versions, "bun", own)
	}
	if (version === undefined) Reflect.deleteProperty(process.versions, "bun")
	else Object.defineProperty(process.versions, "bun", { configurable: true, enumerable: true, value: version })
	let result: T
	try {
		result = body()
	} catch (error) {
		restore()
		throw error
	}
	if (result instanceof Promise) return result.finally(restore) as T
	restore()
	return result
}
