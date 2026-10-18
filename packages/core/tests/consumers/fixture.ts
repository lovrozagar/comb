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
	async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
		const parsed = schema.parse(Object.fromEntries(new URL(request.url).searchParams))
		const query = buildListQuery({ parsed, table: post })
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
