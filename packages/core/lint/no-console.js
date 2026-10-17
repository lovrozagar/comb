import { srcPath } from "./scope.js"

/* Library code never prints: the logger and the CLI output are the two sinks, so every other
 * line writes through an injected sink and its output is assertable in tests. */
const SINKS = new Set(["log.ts", "cli/output.ts"])

export const rule = {
	create(context) {
		const path = srcPath(context.filename)
		if (path === null || SINKS.has(path)) return {}
		return {
			MemberExpression(node) {
				if (node.object.type !== "Identifier" || node.object.name !== "console") return
				context.report({
					message: "console belongs to src/log.ts and src/cli/output.ts; write through the injected sink",
					node,
				})
			},
		}
	},
}
