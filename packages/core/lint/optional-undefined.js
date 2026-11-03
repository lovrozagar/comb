import { srcPath } from "./scope.js"

/* comb reads an optional key set to undefined as the key left out. A declaration that refuses
 * undefined says otherwise, so a consumer under exactOptionalPropertyTypes forwarding a maybe-unset
 * value got TS2379 for a value comb takes (KT8 of r22b). One rule: every optional property says it.
 * A type whose key is absent or set but never undefined says that with Partial<{…}>: a zod shape, and
 * what comb hands back for a consumer to pass on, as the list extras drizzle's select takes. */
const MESSAGE =
	"an optional property takes undefined, which comb reads as the key left out: declare it `name?: T | undefined`, a method as `name?: ((…) => R) | undefined`"

/* the types that already admit undefined: undefined itself, unknown, any, and a union holding undefined */
const ADMITS = new Set(["TSAnyKeyword", "TSUndefinedKeyword", "TSUnknownKeyword"])
const admitsUndefined = (type) =>
	ADMITS.has(type.type) || (type.type === "TSUnionType" && type.types.some((member) => admitsUndefined(member)))

export const rule = {
	create(context) {
		if (srcPath(context.filename) === null) return {}
		/** Reports an optional member whose declared type refuses undefined; one with no type is any */
		const check = (node) => {
			if (node.optional !== true) return
			if (
				node.type === "TSMethodSignature" ||
				(node.typeAnnotation && !admitsUndefined(node.typeAnnotation.typeAnnotation))
			)
				context.report({ message: MESSAGE, node })
		}
		return { PropertyDefinition: check, TSMethodSignature: check, TSPropertySignature: check }
	},
}
