/* The v8 coverage provider honors v8, c8 and istanbul hints alike; a hint hides uncovered code
 * behind a 100% number. */
const HINT = /\b(?:v8|c8|istanbul)\s+ignore\b/i

export const rule = {
	create(context) {
		return {
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					if (!HINT.test(comment.value)) continue
					context.report({
						message: "coverage ignore hints are forbidden; delete the code or give it a case",
						node: comment,
					})
				}
			},
		}
	},
}
