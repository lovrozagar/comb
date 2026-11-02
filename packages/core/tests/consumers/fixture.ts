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

/* the subpaths a Worker imports at runtime: all but the tooling, which runs under Node */
const RUNTIME = SUBPATHS.filter(
	(spec) => !/^@lovrozagar\/comb\/(?:cli|codegen|migrate|package\.json)(?:\/|$)/.test(spec),
)

/** A module that imports the types of every runtime subpath, for a Worker's own lib (K1 of r17) */
export const WORKER_TYPES = `${RUNTIME.map((spec, i) => `import type * as m${i} from "${spec}"`).join("\n")}
export type All = [${RUNTIME.map((_, i) => `typeof m${i}`).join(", ")}]
`

/** A module that exports list and retrieve schemas, their types inferred, as an app's route module does (K11 of r17) */
export const SCHEMAS = `import { createListQuerySchema, createRetrieveQuerySchema } from "@lovrozagar/comb/query"
export const listSchema = createListQuerySchema({ sort: ["created_at"] })
export const retrieveSchema = createRetrieveQuerySchema({ fields: { scalars: ["id"] } })
`

/** A D1-only project's migrate config, which needs neither @libsql/client nor libpg-query (K2 of r17) */
export const MIGRATE_CONFIG = `import { defineConfig } from "@lovrozagar/comb/migrate"
export default defineConfig({
	databases: { core: { migrationsDir: "migrations", name: "core", provider: { databaseName: "CORE_DB", type: "d1" } } },
})
`

/* where the stage installs the floor of comb's workers-types range, apart from the app's own */
const FLOOR = "floor/node_modules"

const STRICT = {
	exactOptionalPropertyTypes: true,
	noPropertyAccessFromIndexSignature: true,
	noUncheckedIndexedAccess: true,
	skipLibCheck: true,
	strict: true,
	target: "es2023",
	types: ["@cloudflare/workers-types", "node"],
}

/** create-cloudflare 2.74.6's templates/hello-world/ts/tsconfig.json, verbatim: comb's main audience, no flag added (K1 of r20) */
export const CREATE_CLOUDFLARE_TSCONFIG = `{
	"compilerOptions": {
		/* Visit https://aka.ms/tsconfig.json to read more about this file */

		/* Set the JavaScript language version for emitted JavaScript and include compatible library declarations. */
		"target": "es2024",
		/* Specify a set of bundled library declaration files that describe the target runtime environment. */
		"lib": ["es2024"],
		/* Specify what JSX code is generated. */
		"jsx": "react-jsx",

		/* Specify what module code is generated. */
		"module": "es2022",
		/* Specify how TypeScript looks up a file from a given module specifier. */
		"moduleResolution": "Bundler",
		/* Enable importing .json files */
		"resolveJsonModule": true,

		/* Allow JavaScript files to be a part of your program. Use the \`checkJS\` option to get errors from these files. */
		"allowJs": true,
		/* Enable error reporting in type-checked JavaScript files. */
		"checkJs": false,

		/* Disable emitting files from a compilation. */
		"noEmit": true,

		/* Ensure that each file can be safely transpiled without relying on other imports. */
		"isolatedModules": true,
		/* Allow 'import x from y' when a module doesn't have a default export. */
		"allowSyntheticDefaultImports": true,
		/* Ensure that casing is correct in imports. */
		"forceConsistentCasingInFileNames": true,

		/* Enable all strict type-checking options. */
		"strict": true,

		/* Skip type checking all .d.ts files. */
		"skipLibCheck": true
	},
	"exclude": ["test"],
	"include": ["worker-configuration.d.ts", "src/**/*.ts"]
}
`

/* the flags a consumer might add to it, beyond `strict`: comb's surface must hold under all of them (meta-contract §10) */
const STRICT_UNION = {
	allowUnreachableCode: false,
	allowUnusedLabels: false,
	erasableSyntaxOnly: true,
	exactOptionalPropertyTypes: true,
	noFallthroughCasesInSwitch: true,
	noImplicitOverride: true,
	noImplicitReturns: true,
	noPropertyAccessFromIndexSignature: true,
	noUncheckedIndexedAccess: true,
	noUncheckedSideEffectImports: true,
	noUnusedLocals: true,
	noUnusedParameters: true,
	verbatimModuleSyntax: true,
}

/** The files every staged consumer holds: the Worker, the types module, two tsconfigs, wrangler and vite config */
export const APP: Record<string, string> = {
	"src/count-eval.ts": COUNT_EVAL,
	"src/no-eval.ts": NO_EVAL_WORKER,
	"comb.migrate.config.ts": MIGRATE_CONFIG,
	"src/schemas.ts": SCHEMAS,
	"src/types.ts": ALL_TYPES,
	"src/worker-types.ts": WORKER_TYPES,
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
	/* the migrate config alone, Node's types alone: no optional peer's types are needed (K2 of r17) */
	"tsconfig.migrate.json": JSON.stringify({
		compilerOptions: {
			...STRICT,
			allowImportingTsExtensions: true,
			module: "esnext",
			moduleResolution: "bundler",
			noEmit: true,
			types: ["node"],
		},
		include: ["comb.migrate.config.ts"],
	}),
	/* declarations emitted for a module that exports comb's schemas: each type has a public name (K11 of r17) */
	"tsconfig.declarations.json": JSON.stringify({
		compilerOptions: {
			...STRICT,
			allowImportingTsExtensions: true,
			declaration: true,
			emitDeclarationOnly: true,
			module: "esnext",
			moduleResolution: "bundler",
			outDir: "decl",
			rootDir: "src",
		},
		include: ["src/schemas.ts"],
	}),
	/* a stock Worker project: no DOM, workers-types alone, as \`wrangler types\` sets it up (K1 of r17) */
	"tsconfig.worker.json": JSON.stringify({
		compilerOptions: {
			...STRICT,
			allowImportingTsExtensions: true,
			lib: ["esnext"],
			module: "esnext",
			moduleResolution: "bundler",
			noEmit: true,
			types: ["@cloudflare/workers-types"],
		},
		include: ["src/worker-types.ts"],
	}),
	/* the Workers side of create-cloudflare's React Router template: lib ES2022, the floor comb's runtime subpaths keep to (K2 of r20) */
	"tsconfig.worker-es2022.json": JSON.stringify({
		compilerOptions: {
			...STRICT,
			allowImportingTsExtensions: true,
			lib: ["DOM", "DOM.Iterable", "ES2022"],
			module: "esnext",
			moduleResolution: "bundler",
			noEmit: true,
			target: "es2022",
			types: ["@cloudflare/workers-types"],
		},
		include: ["src/worker-types.ts"],
	}),
	/* a nodejs_compat Worker, or a package whose scripts run on Node: no DOM, Workers' and Node's types, every subpath (K1 of r18) */
	"tsconfig.worker-node.json": JSON.stringify({
		compilerOptions: {
			...STRICT,
			allowImportingTsExtensions: true,
			lib: ["esnext"],
			module: "esnext",
			moduleResolution: "bundler",
			noEmit: true,
		},
		include: ["src/types.ts"],
	}),
	/* the same, at the floor of comb's workers-types range, which the stage installs beside the app (R4 of plan 17) */
	"tsconfig.worker-node-floor.json": JSON.stringify({
		compilerOptions: {
			...STRICT,
			allowImportingTsExtensions: true,
			lib: ["esnext"],
			module: "esnext",
			moduleResolution: "bundler",
			noEmit: true,
			paths: { "@cloudflare/workers-types": [`./${FLOOR}/@cloudflare/workers-types`] },
			typeRoots: [`./${FLOOR}/@cloudflare`, "./node_modules/@types"],
			types: ["workers-types", "node"],
		},
		include: ["src/types.ts"],
	}),
	/* everything bundled, so tooling that leaked into a runtime import would show in the output */
	"vite.config.mjs": `export default { build: { outDir: "dist-vite" }, ssr: { noExternal: true } }\n`,
	"wrangler.toml": 'name = "consumer"\nmain = "src/worker.ts"\ncompatibility_date = "2026-10-01"\n',
	/* a project create-cloudflare scaffolds, apart from the app's own files its src glob would take in */
	"c3/tsconfig.json": CREATE_CLOUDFLARE_TSCONFIG,
	/* what `wrangler types` writes, reduced to the globals comb's surface needs */
	"c3/worker-configuration.d.ts": '/// <reference types="@cloudflare/workers-types" />\n',
	"c3/src/index.ts": WORKER,
	"c3/src/types.ts": WORKER_TYPES,
	"c3/tsconfig.strict.json": JSON.stringify({ compilerOptions: STRICT_UNION, extends: "./tsconfig.json" }),
}
