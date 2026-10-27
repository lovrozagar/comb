import { srcPath } from "./scope.js"

/* Generated output must be the same bytes on every machine. `localeCompare` follows the machine's
 * LANG under node, so an order it decides moves between two developers' machines (F40). */
const MESSAGE =
	"localeCompare orders by the machine's locale, so output differs between machines; compare with byCodeUnit from src/codegen/utils/order.ts"

export const rule = {
	create(context) {
		if (srcPath(context.filename) === null) return {}
		return {
			MemberExpression(node) {
				const { computed, property } = node
				const name = computed ? property.value : property.name
				if (name === "localeCompare") context.report({ message: MESSAGE, node })
			},
		}
	},
}
