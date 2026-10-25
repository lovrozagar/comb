/**
 * The module hooks codegen's child runs under node, which loads no TypeScript of its own on the
 * versions comb supports: a TypeScript file is transpiled with the TypeScript ts-morph bundles,
 * under the consumer's tsconfig, and
 * a specifier node cannot resolve (no extension, a tsconfig `paths` alias) is resolved as the
 * consumer's tsconfig resolves it. Plain JavaScript, as node loads hooks before any TypeScript.
 * Bun loads TypeScript itself and runs none of this.
 */
import nodeModule from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ts } from "ts-morph"
import fs from "node:fs"
import { compilerOptionsFor, runsAsCommonJs, transpiled } from "./ts-options.mjs"

const TYPESCRIPT = /\.(?:ts|tsx|mts|cts)$/

/**
 * The URL a specifier names from a TypeScript parent, as the consumer's tsconfig resolves it;
 * undefined when it does not name a project file
 * @param {string} specifier
 * @param {string | undefined} parentURL
 * @returns {string | undefined}
 */
function tsResolved(specifier, parentURL) {
	if (parentURL === undefined || !parentURL.startsWith("file:")) return undefined
	const parent = fileURLToPath(parentURL)
	if (!TYPESCRIPT.test(parent)) return undefined
	const resolved = ts.resolveModuleName(specifier, parent, compilerOptionsFor(parent), ts.sys).resolvedModule
	if (resolved === undefined || resolved.isExternalLibraryImport === true) return undefined
	return pathToFileURL(resolved.resolvedFileName).href
}

/**
 * Resolve as node does, then as the consumer's tsconfig does for what node cannot find
 * @param {string} specifier
 * @param {{ parentURL?: string | undefined }} context
 * @param {(specifier: string, context: unknown) => { url: string }} nextResolve
 */
export function resolveSync(specifier, context, nextResolve) {
	try {
		return nextResolve(specifier, context)
	} catch (error) {
		// reason: node's error stands unless the tsconfig names the file, and is rethrown below when it does not
		const url = tsResolved(specifier, context.parentURL)
		if (url === undefined) throw error
		return { shortCircuit: true, url }
	}
}

/**
 * A TypeScript file in the format node itself gives it, transpiled to that format (F54); anything
 * else as node loads it
 * @param {string} url
 * @param {unknown} context
 * @param {(url: string, context: unknown) => unknown} nextLoad
 */
export function loadSync(url, context, nextLoad) {
	/* by its path: comb imports comb.config.ts with a ?mtime= query */
	if (!url.startsWith("file:") || !TYPESCRIPT.test(new URL(url).pathname)) return nextLoad(url, context)
	const file = fileURLToPath(url)
	if (!runsAsCommonJs(file, fs.readFileSync(file, "utf8")))
		return { format: "module", shortCircuit: true, source: transpiled(file) }
	return { format: "commonjs", shortCircuit: true, source: transpiled(file, ts.ModuleKind.CommonJS) }
}

/**
 * The same hooks for `module.register`, which runs them off the main thread and awaits them
 * @param {string} specifier
 * @param {{ parentURL?: string | undefined }} context
 * @param {(specifier: string, context: unknown) => Promise<{ url: string }>} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context)
	} catch (error) {
		// reason: node's error stands unless the tsconfig names the file, and is rethrown below when it does not
		const url = tsResolved(specifier, context.parentURL)
		if (url === undefined) throw error
		return { shortCircuit: true, url }
	}
}

/**
 * @param {string} url
 * @param {unknown} context
 * @param {(url: string, context: unknown) => Promise<unknown>} nextLoad
 */
export async function load(url, context, nextLoad) {
	return loadSync(url, context, nextLoad)
}

/**
 * Install the hooks: in-thread with `module.registerHooks` (node 22.15 and later), else off-thread
 * with `module.register`
 * @param {{ registerHooks?: Function, register: Function }} api
 * @returns {{ deregister?: () => void } | undefined}
 */
export function install(api = nodeModule) {
	if (typeof api.registerHooks === "function") return api.registerHooks({ load: loadSync, resolve: resolveSync })
	api.register(import.meta.url)
	return undefined
}
