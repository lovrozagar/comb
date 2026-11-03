import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSync } from "oxc-parser"
import { srcPath } from "./scope.js"

/* comb reads an optional key set to undefined as the key left out. A declaration that refuses
 * undefined says otherwise, so a consumer under exactOptionalPropertyTypes forwarding a maybe-unset
 * value got TS2379 for a value comb takes (KT8 of r22b). One rule: every optional property says it.
 * What comb hands back keeps a key absent or set, never undefined, so a consumer passes it on as it
 * is: that is Partial<…>, in a return type or in an alias only return types reach (AD2 of the area D
 * review), a callback's parameter being one comb hands out. A Partial<…> a parameter or a config
 * property reaches is an input bag, and refuses undefined the same way: it is declared
 * `{ [K in …]?: T | undefined }`. A parameter typed by what comb itself built and hands back looks
 * the same as one typed by a consumer's input comb returns parsed (loadCombConfig's CodegenConfig),
 * so each such output comb takes back is named in TAKEN_BACK with why it stays Partial<…>. */
const MESSAGE =
	"an optional property takes undefined, which comb reads as the key left out: declare it `name?: T | undefined`, a method as `name?: ((…) => R) | undefined`"
const PARTIAL =
	"a Partial<…> that comb reads refuses undefined, which comb reads as the key left out: declare the input `{ [K in …]?: T | undefined }`; Partial<…> is for what comb hands back, in a return type or an alias only return types reach"

/** The outputs comb takes back as it built them, each kept Partial<…> for the reason given */
export const TAKEN_BACK = new Map([
	[
		"ListExtras",
		"buildListQuery's extras, which applyListQuery takes back in the built list; a consumer spreads them into drizzle's select, whose fields refuse undefined",
	],
])

/* the types that already admit undefined: undefined itself, unknown, any, and a union holding undefined */
const ADMITS = new Set(["TSAnyKeyword", "TSUndefinedKeyword", "TSUnknownKeyword"])
const admitsUndefined = (type) =>
	ADMITS.has(type.type) || (type.type === "TSUnionType" && type.types.some((member) => admitsUndefined(member)))

/**
 * Which way a type written at the end of `path` (its ancestors, outermost first, each with the key
 * it hangs by) flows. Each function parameter it sits in flips it: comb reads its own parameter and
 * hands out a callback's. At the top of the file it is comb's own value ("output"), a type a class
 * field or a type parameter holds is a caller's ("input"), and one in an alias or interface flows
 * as that type does, flipped or not.
 */
function placeOf(path) {
	let flip = false
	for (let at = path.length - 1; at > 0; at--) {
		const { key } = path[at]
		const parent = path[at - 1].node
		if (key === "typeParameters" || parent.type === "PropertyDefinition") return "input"
		/* a type argument list hangs its types by `params` too; only a function's parameters flip */
		if (key === "params" && parent.type !== "TSTypeParameterInstantiation") flip = !flip
		if (parent.type === "TSTypeAliasDeclaration" || parent.type === "TSInterfaceDeclaration")
			return { alias: parent.id.name, flip }
	}
	return flip ? "input" : "output"
}

/** Every named type reference in `program`, by name, with where each sits */
function referencesIn(program) {
	const found = []
	const visit = (node, path) => {
		if (node.type === "TSTypeReference" && node.typeName.type === "Identifier") {
			found.push({ name: node.typeName.name, node, place: placeOf(path) })
		}
		for (const [key, value] of Object.entries(node)) {
			if (key === "parent") continue
			for (const child of Array.isArray(value) ? value : [value]) {
				if (typeof child === "object" && child !== null && typeof child.type === "string")
					visit(child, [...path, { key, node: child }])
			}
		}
	}
	visit(program, [{ key: null, node: program }])
	return found
}

/* the references of every source file under a src root, as read from disk once per lint run */
const roots = new Map()
function diskReferences(root) {
	const cached = roots.get(root)
	if (cached) return cached
	const byFile = new Map()
	let files = []
	try {
		files = readdirSync(root, { encoding: "utf8", recursive: true })
	} catch {
		/* a root with no source on disk, as the in-process rule harness's fixtures have, holds none */
		files = []
	}
	for (const file of files.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
		const path = join(root, file)
		const parsed = parseSync(path, readFileSync(path, "utf8"))
		byFile.set(
			path,
			referencesIn(parsed.program).map(({ name, place }) => ({ name, place })),
		)
	}
	roots.set(root, byFile)
	return byFile
}

/**
 * Which ways alias `name` flows across src: an alias nothing in src names is a type a consumer
 * fills, so an input. `path` holds the aliases already followed, so a cycle adds nothing.
 */
function flowsOf(name, places, path = new Set()) {
	const where = places.get(name)
	if (where === undefined) return new Set(["input"])
	if (path.has(name)) return new Set()
	const flows = new Set()
	for (const place of where) {
		if (typeof place === "string") flows.add(place)
		else for (const flow of flowsOf(place.alias, places, new Set([...path, name]))) flows.add(flipped(flow, place.flip))
	}
	return flows
}

const flipped = (flow, flip) => (flip === (flow === "output") ? "input" : "output")

export const rule = {
	create(context) {
		const file = srcPath(context.filename)
		if (file === null) return {}
		const filename = String(context.filename).replaceAll("\\", "/")
		const root = filename.slice(0, filename.length - file.length)
		/** Reports an optional member whose declared type refuses undefined; one with no type is any */
		const check = (node) => {
			if (node.optional !== true) return
			if (
				node.type === "TSMethodSignature" ||
				(node.typeAnnotation && !admitsUndefined(node.typeAnnotation.typeAnnotation))
			)
				context.report({ message: MESSAGE, node })
		}
		/** Reports a Partial<…> an input reaches: this file's references read afresh, every other file's from disk */
		const partials = (program) => {
			const here = referencesIn(program)
			const places = new Map()
			const add = (name, place) => places.set(name, [...(places.get(name) ?? []), place])
			for (const [path, references] of diskReferences(root)) {
				if (path.replaceAll("\\", "/") !== filename) for (const { name, place } of references) add(name, place)
			}
			for (const { name, place } of here) add(name, place)
			for (const { name, node, place } of here) {
				if (name !== "Partial" || place === "output") continue
				if (place !== "input" && TAKEN_BACK.has(place.alias)) continue
				if (
					place === "input" ||
					[...flowsOf(place.alias, places)].some((flow) => flipped(flow, place.flip) === "input")
				)
					context.report({ message: PARTIAL, node })
			}
		}
		return { Program: partials, PropertyDefinition: check, TSMethodSignature: check, TSPropertySignature: check }
	},
}
