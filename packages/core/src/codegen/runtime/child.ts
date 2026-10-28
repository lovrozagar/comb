/**
 * The child's half of the runtime read: writeSnapshot([tables, result]), which load.ts's child runs, reads the tables
 * module and writes the snapshot, or the error that stopped it, to the result file, which the
 * parent reads. Its own stdout and stderr stay the module's, so a module that logs cannot corrupt it.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { moduleGraph } from "./module-graph.ts"
import { type Loaded, type Namespace, snapshotOf } from "./read-tables.ts"
import type { Snapshot } from "./snapshot-types.ts"

/** How a module is loaded: the runtime's own import(), or a test's stand-in */
type Importer = (url: string) => Promise<unknown>

/**
 * Every table the tables module exports, read at runtime. Loading runs the module, which must be
 * import-safe, and a load error in it fails the read. Another module the walk finds (a project file
 * or a package, each as the file importing it resolves it) that does not load on its own is skipped,
 * and named only when a schema it might have held is then found nowhere.
 */
async function readTables(tablesPath: string, importer: Importer = (url) => import(url)): Promise<Snapshot> {
	const graph = moduleGraph(tablesPath)
	const [first, ...rest] = graph.files as [string, ...string[]]
	const loaded: Loaded[] = [
		{ external: false, module: first, namespace: (await importer(pathToFileURL(first).href)) as Namespace },
	]
	const resolve = import.meta.resolve as (specifier: string, parent: string) => string
	const others = [
		...rest.map((module) => ({ external: false, module, url: () => pathToFileURL(module).href })),
		...graph.packages.map(({ from, specifier }) => ({
			external: true,
			module: specifier,
			url: () => resolve(specifier, pathToFileURL(from).href),
		})),
	]
	const unloaded: string[] = []
	for (const { external, module, url } of others) {
		if (loaded.some((each) => each.module === module) || unloaded.includes(module)) continue
		try {
			loaded.push({ external, module, namespace: (await importer(url())) as Namespace })
		} catch {
			// reason: the tables module loaded, so this one need not; a schema it would have held is reported by name
			unloaded.push(module)
		}
	}
	return snapshotOf(loaded, unloaded)
}

/* comb's own source, whose frames are the loader's and never the project's */
const COMB_SRC = /* @__PURE__ */ path.resolve(import.meta.dirname, "../..")

/**
 * The first frame of `error`'s stack in the project's own code, `file:line:col`: past comb's own
 * source, a package and node's internals, so a throw in a module the tables file imports names
 * that module (F64); undefined when no frame is the project's
 */
function projectFrame(error: unknown): string | undefined {
	const stack = error instanceof Error ? (error.stack ?? "") : ""
	for (const [, location] of stack.matchAll(/^\s*at (?:.*\()?((?:file:\/\/)?\/[^()]+:\d+:\d+)\)?$/gm)) {
		const at = (location as string).startsWith("file://") ? fileURLToPath(location as string) : (location as string)
		const file = at.replace(/:\d+:\d+$/, "")
		if (!file.includes(`${path.sep}node_modules${path.sep}`) && !file.startsWith(COMB_SRC)) return at
	}
	return undefined
}

/** Read `tablesPath` and write what came of it to `resultPath` */
async function writeSnapshot([tablesPath, resultPath]: readonly string[]): Promise<void> {
	if (tablesPath === undefined || resultPath === undefined) throw new Error("writeSnapshot takes [tables, result]")
	let result: unknown
	try {
		result = { snapshot: await readTables(tablesPath) }
	} catch (error) {
		// reason: the parent reports the error, naming the tables file; this process only carries it across
		const at = projectFrame(error)
		result = { error: error instanceof Error ? error.message : String(error), ...(at === undefined ? {} : { at }) }
	}
	fs.writeFileSync(resultPath, JSON.stringify(result))
}

export { projectFrame, readTables, writeSnapshot, type Importer }
