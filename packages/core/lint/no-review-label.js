/* A review label (KC2 of r22b) in shipped src names a finding no consumer can look up. A comment
 * says the reason instead, and the commit message keeps the label. A string or template is checked
 * too: codegen emits its JSDoc from them, and a message carries one to its reader. */
import { reviewLabels } from "./review-labels.js"
import { srcPath } from "./scope.js"

const COMMENT = (label) =>
	`a shipped comment cites the review label "${label}"; say the reason, and keep the label in the commit`
const STRING = (label) =>
	`a shipped string cites the review label "${label}", which generated code or a message would carry`

export const rule = {
	create(context) {
		/* a fixture is test data the tarball leaves out, as a test is */
		const path = srcPath(context.filename)
		if (path === null || path.split("/").includes("__fixtures__")) return {}
		const check = (text, node, message) => {
			const [label] = reviewLabels(text)
			if (label !== undefined) context.report({ message: message(label), node })
		}
		return {
			Literal(node) {
				if (typeof node.value === "string") check(node.value, node, STRING)
			},
			Program() {
				for (const comment of context.sourceCode.getAllComments()) check(comment.value, comment, COMMENT)
			},
			TemplateElement(node) {
				check(node.value.cooked ?? node.value.raw, node, STRING)
			},
		}
	},
}
