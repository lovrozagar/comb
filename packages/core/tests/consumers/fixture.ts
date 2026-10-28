/** The consumer app the cells build: a Worker on comb's runtime subpaths, and a module that types every subpath. */
import { SUBPATHS } from "./stage.ts"

export const WORKER = `import { createListQuerySchema } from "@lovrozagar/comb/query"
import { buildListQuery } from "@lovrozagar/comb/query/sqlite"
import { c } from "@lovrozagar/comb/sqlite/columns"
import { d1ErrorHandler } from "@lovrozagar/comb/sqlite/d1/error-handler"
import { openD1Session } from "@lovrozagar/comb/sqlite/d1/session"
import { ShardRouter } from "@lovrozagar/comb/sqlite/d1/sharding"
import { sqliteTable } from "drizzle-orm/sqlite-core"

const post = sqliteTable("post", { id: c.id("pst"), title: c.text("title") })
const schema = createListQuerySchema({ sort: ["title"] })
const router = new ShardRouter({ totalShards: 2 })

export default {
	async fetch(request: Request, env: { CURSOR_SECRET: string; DB: D1Database }): Promise<Response> {
		const parsed = schema.parse(Object.fromEntries(new URL(request.url).searchParams))
		const query = buildListQuery({ cursorScope: "post:list", cursorSecret: env.CURSOR_SECRET, parsed, table: post })
		const { client } = openD1Session(env.DB)
		try {
			return Response.json({ limit: query.limit, ok: typeof client, router: typeof router })
		} catch (error) {
			d1ErrorHandler(error, [])
			throw error
		}
	},
}
`

/**
 * Counts every Function made from a string. Imported first, so it is in place before comb's modules
 * build their schemas; on workerd the call then throws, as it refuses code from strings (4.18)
 */
export const COUNT_EVAL = `const Real = globalThis.Function
export const counter = { made: 0 }
globalThis.Function = new Proxy(Real, {
	apply: (target, self, args) => (counter.made++, Reflect.apply(target, self, args)),
	construct: (target, args) => (counter.made++, Reflect.construct(target, args)),
})
`

/** A Worker that builds and parses comb's query schemas and says how many Functions that made */
export const NO_EVAL_WORKER = `import { counter } from "./count-eval.ts"
import { createListQuerySchema, createRetrieveQuerySchema, paginationResponseSchema } from "@lovrozagar/comb/query"

export default {
	async fetch(): Promise<Response> {
		const list = createListQuerySchema({ filter: { status: "enum" }, sort: ["createdAt", "name"] as const })
		const retrieve = createRetrieveQuerySchema({ fields: { scalars: ["id", "name"] } })
		const parsed = [
			list.safeParse({ filter: "status.eq.active", limit: "10", order: "name.desc" }).success,
			retrieve.safeParse({ select: "id" }).success,
			paginationResponseSchema.safeParse({ count: 1, hasMore: false, limit: 10, nextCursor: null, page: 1 }).success,
		]
		return Response.json({ made: counter.made, parsed })
	},
}
`

/** A module that imports the types of every subpath */
export const ALL_TYPES = `${SUBPATHS.map((spec, i) => `import type * as m${i} from "${spec}"`).join("\n")}
export type All = [${SUBPATHS.map((_, i) => `typeof m${i}`).join(", ")}]
`

const STRICT = {
	exactOptionalPropertyTypes: true,
	noPropertyAccessFromIndexSignature: true,
	noUncheckedIndexedAccess: true,
	skipLibCheck: true,
	strict: true,
	target: "es2023",
	types: ["@cloudflare/workers-types", "node"],
}

/** The files every staged consumer holds: the Worker, the types module, two tsconfigs, wrangler and vite config */
export const APP: Record<string, string> = {
	"src/count-eval.ts": COUNT_EVAL,
	"src/no-eval.ts": NO_EVAL_WORKER,
	"src/types.ts": ALL_TYPES,
	"src/worker.ts": WORKER,
	/* a bundler project: comb's .ts source compiles as the app's own */
	"tsconfig.bundler.json": JSON.stringify({
		compilerOptions: {
			...STRICT,
			allowImportingTsExtensions: true,
			module: "esnext",
			moduleResolution: "bundler",
			noEmit: true,
		},
		include: ["src/types.ts"],
	}),
	/* a Node project: nodenext, emitting, with the .ts imports rewritten to .js */
	"tsconfig.nodenext.json": JSON.stringify({
		compilerOptions: {
			...STRICT,
			module: "nodenext",
			moduleResolution: "nodenext",
			outDir: "out",
			rewriteRelativeImportExtensions: true,
			rootDir: "src",
		},
		include: ["src/types.ts"],
	}),
	/* everything bundled, so tooling that leaked into a runtime import would show in the output */
	"vite.config.mjs": `export default { build: { outDir: "dist-vite" }, ssr: { noExternal: true } }\n`,
	"wrangler.toml": 'name = "consumer"\nmain = "src/worker.ts"\ncompatibility_date = "2026-10-01"\n',
}
