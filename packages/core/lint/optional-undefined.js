import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path/posix"
import { parseSync } from "oxc-parser"
import { moduleOf, scopeOf } from "./generic-scope.js"
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
const MAPPED =
	"an optional mapped key takes undefined, which comb reads as the key left out: declare it `{ [K in …]?: T | undefined }`"
const TUPLE =
	"an optional tuple element takes undefined, which comb reads as the element left out: declare it `[name?: T | undefined]`, an unnamed one `[(T | undefined)?]`"
const PARTIAL =
	"a Partial<…> that comb reads refuses undefined, which comb reads as the key left out: declare the input `{ [K in …]?: T | undefined }`; Partial<…> is for what comb hands back, in a return type or an alias only return types reach"

/** The outputs comb takes back as it built them, each kept Partial<…> for the reason given */
export const TAKEN_BACK = new Map([
	[
		"ListExtras",
		"buildListQuery's extras, which applyListQuery takes back in the built list; a consumer spreads them into drizzle's select, whose fields refuse undefined",
	],
])

/* the types that already admit undefined: undefined itself, unknown, any, and a union holding undefined, in parentheses or not */
const ADMITS = new Set(["TSAnyKeyword", "TSUndefinedKeyword", "TSUnknownKeyword"])
const admitsUndefined = (type) =>
	ADMITS.has(type.type) ||
	(type.type === "TSParenthesizedType" && admitsUndefined(type.typeAnnotation)) ||
	(type.type === "TSUnionType" && type.types.some((member) => admitsUndefined(member)))

/* a private or #-named class field or method is comb's own, which no caller sets (D2-6 of the area D round-two review, D4-3 of round four) */
const ownField = (node) => node.accessibility === "private" || node.key.type === "PrivateIdentifier"

/* a class field a caller or a subclass sets, an abstract one included (D3-3 of the area D round-three review) */
const FIELDS = new Set(["PropertyDefinition", "TSAbstractPropertyDefinition"])
const callerField = (node) => FIELDS.has(node.type) && !ownField(node)

/* an optional method's type is a function, which never admits undefined: a class's too (D4-3 of the area D round-four review) */
const METHODS = new Set(["MethodDefinition", "TSAbstractMethodDefinition", "TSMethodSignature"])
/* the class members a private or # name makes comb's own */
const MEMBERS = new Set(["MethodDefinition", "PropertyDefinition"])

/* what a reference names: a type reference's type, or the type an interface extends or a class
 * implements, a namespace's member as `A.Name` */
const HERITAGE = new Set(["TSClassImplements", "TSInterfaceHeritage"])
const nameOf = (name) =>
	name?.type === "Identifier"
		? name.name
		: name?.type === "TSQualifiedName" && name.left.type === "Identifier"
			? `${name.left.name}.${name.right.name}`
			: null
const namedBy = (node) =>
	nameOf(node.type === "TSTypeReference" ? node.typeName : HERITAGE.has(node.type) ? node.expression : null)

/** Calls `found` with every node under `node` and the path to it, `node` itself first */
function walk(node, path, found) {
	found(node, path)
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue
		for (const child of Array.isArray(value) ? value : [value]) {
			if (typeof child === "object" && child !== null && typeof child.type === "string")
				walk(child, [...path, { key, node: child }], found)
		}
	}
}

/**
 * How type argument `index` of `owner` flows inside the generic alias or interface of src it
 * names: flipped (true) when its type parameter sits in a function parameter there, as it is (false)
 * when it is unused or no such alias holds it, and "both" when comb reads it and hands it out alike.
 * `scope` looks up the generic a name in this file stands for (`lookup`), and in the file that
 * declares one (`scopes`), and holds in `seen` those already followed, so a cycle adds nothing.
 */
function argumentFlow(owner, index, scope) {
	const { lookup, scopes, seen } = scope
	const name = namedBy(owner)
	const found = name === null ? undefined : lookup(name)
	const alias = found?.declared
	const parameter = alias?.typeParameters.params[index]
	if (parameter === undefined || seen.has(alias)) return false
	const flips = new Set()
	walk(alias, [{ key: null, node: alias }], (node, path) => {
		if (namedBy(node) !== parameter.name.name || node.type !== "TSTypeReference") return
		const place = placeOf(path, { lookup: scopes(found.file), scopes, seen: new Set([...seen, alias]) })
		if (place === "input") flips.add(true).add(false)
		else flips.add(place.flip)
	})
	return flips.size === 2 ? "both" : flips.has(true)
}

/**
 * Which way a type written at the end of `path` (its ancestors, outermost first, each with the key
 * it hangs by) flows. Each function parameter it sits in flips it: comb reads its own parameter and
 * hands out a callback's. A type argument of a generic alias of src flows as that alias's type
 * parameter does there. At the top of the file it is comb's own value ("output"), a type a type
 * parameter or a caller-set class field holds is a caller's ("input"), and one in an alias or
 * interface flows as that type does, flipped or not.
 */
function placeOf(path, scope) {
	let flip = false
	for (let at = path.length - 1; at > 0; at--) {
		const { key, node } = path[at]
		const parent = path[at - 1].node
		if (key === "typeParameters" || callerField(parent)) return "input"
		/* a type argument list hangs its types by `params` too; only a function's parameters flip */
		if (key === "params" && parent.type === "TSTypeParameterInstantiation") {
			const flow = argumentFlow(path[at - 2].node, parent.params.indexOf(node), scope)
			if (flow === "both") return "input"
			if (flow) flip = !flip
		} else if (key === "params") flip = !flip
		if (parent.type === "TSTypeAliasDeclaration" || parent.type === "TSInterfaceDeclaration")
			return { alias: parent.id.name, flip }
	}
	return flip ? "input" : "output"
}

/** Every named type reference in `program`, by name, with where each sits; `lookup` and `scopes` find the generics it names */
function referencesIn(program, lookup, scopes) {
	const found = []
	walk(program, [{ key: null, node: program }], (node, path) => {
		const name = namedBy(node)
		if (name !== null) found.push({ name, node, place: placeOf(path, { lookup, scopes, seen: new Set() }) })
	})
	return found
}

/* every source file under a src root, as a module, each file's lookup, and each file's references, read from disk once per lint run */
const roots = new Map()
function diskReferences(root) {
	const cached = roots.get(root)
	if (cached) return cached
	let files = []
	try {
		files = readdirSync(root, { encoding: "utf8", recursive: true })
	} catch {
		/* a root with no source on disk, as the in-process rule harness's fixtures have, holds none */
		files = []
	}
	const programs = files
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
		.map((file) => join(root, file.replaceAll("\\", "/")))
		.map((path) => [path, parseSync(path, readFileSync(path, "utf8")).program])
	const modules = new Map(programs.map(([path, program]) => [path, moduleOf(program, path)]))
	const lookups = new Map([...modules].map(([path, module]) => [path, scopeOf(module, modules)]))
	const scopes = (file) => lookups.get(file)
	const byFile = new Map(
		programs.map(([path, program]) => [
			path,
			referencesIn(program, scopes(path), scopes).map(({ name, place }) => ({ name, place })),
		]),
	)
	const disk = { byFile, modules, scopes }
	roots.set(root, disk)
	return disk
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
			if (node.optional !== true || (MEMBERS.has(node.type) && ownField(node))) return
			if (METHODS.has(node.type) || (node.typeAnnotation && !admitsUndefined(node.typeAnnotation.typeAnnotation)))
				context.report({ message: MESSAGE, node })
		}
		/** Reports an optional mapped key whose type refuses undefined; `-?` makes it required */
		const mapped = (node) => {
			const optional = node.optional === true || node.optional === "+"
			if (optional && node.typeAnnotation && !admitsUndefined(node.typeAnnotation))
				context.report({ message: MAPPED, node })
		}
		/** Reports an optional tuple element whose type refuses undefined, `[name?: T]` or `[T?]` */
		const tuple = (node) => {
			const type =
				node.type === "TSOptionalType" ? node.typeAnnotation : node.optional === true ? node.elementType : null
			if (type !== null && !admitsUndefined(type)) context.report({ message: TUPLE, node })
		}
		/** Reports a Partial<…> an input reaches: this file's references read afresh, every other file's from disk */
		const partials = (program) => {
			const disk = diskReferences(root)
			/* this file's own generics as it reads now, every other file's as on disk */
			const lookup = scopeOf(moduleOf(program, filename), disk.modules)
			const here = referencesIn(program, lookup, (other) => (other === filename ? lookup : disk.scopes(other)))
			const places = new Map()
			const add = (name, place) => places.set(name, [...(places.get(name) ?? []), place])
			for (const [path, references] of disk.byFile) {
				if (path !== filename) for (const { name, place } of references) add(name, place)
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
		return {
			Program: partials,
			MethodDefinition: check,
			PropertyDefinition: check,
			TSAbstractMethodDefinition: check,
			TSAbstractPropertyDefinition: check,
			TSMappedType: mapped,
			TSMethodSignature: check,
			TSNamedTupleMember: tuple,
			TSOptionalType: tuple,
			TSPropertySignature: check,
		}
	},
}
