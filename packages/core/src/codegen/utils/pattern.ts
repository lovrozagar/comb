/**
 * A constraint's `pattern`, checked at codegen and written back as a regex literal comb built.
 * The value is spliced into the generated DTOs, so one comb cannot emit (no slashes, a newline, a
 * slash unescaped, a template string) failed tsc, or compiled and threw when the module loaded
 * (F5). JSON Schema's `pattern` has no flags, so `i`, `m` and `s`, which change what matches, would
 * publish another rule than the server applies; `g` and `y` mean nothing to one test (F6). JSON
 * Schema compiles a pattern under `u`, as Ajv does, where a `v` source (set subtraction) does not
 * compile (the 0.12 review's F5). So a pattern is `/source/flags` with `u` at most, and a source
 * the engine compiles.
 */

/** The regex literal comb emits for `pattern`, the constraint at `place`; an error naming why it cannot */
function patternLiteral(pattern: string, place: string): string {
	const parts = /^\/([\s\S]+)\/([a-z]*)$/.exec(pattern)
	if (parts === null)
		throw new Error(`${place}: pattern ${JSON.stringify(pattern)} is not a regex: write it as /source/flags`)
	const [, source, flags] = parts as unknown as [string, string, string]
	const refused = [...flags].filter((flag) => flag !== "u")
	if (refused.length > 0) {
		throw new Error(
			`${place}: pattern ${pattern} takes the flag ${refused.join("")}, which JSON Schema cannot publish; write the rule into the source (a case-insensitive letter as [A-Za-z]), with u at most`,
		)
	}
	let compiled: RegExp
	try {
		compiled = RegExp(source, flags)
	} catch (error) {
		throw new Error(`${place}: pattern ${pattern} does not compile: ${(error as Error).message}`, { cause: error })
	}
	/* the engine's own source, the text a regex literal holds: a slash escaped outside a class only, a
	 * line terminator as its escape, so the pattern publishes as the regex in the tables file would */
	return `/${compiled.source}/${flags}`
}

export { patternLiteral }
