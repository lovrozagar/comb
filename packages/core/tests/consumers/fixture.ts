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

/**
 * A script that writes src/reexport.ts, re-exporting every value export of every subpath as a
 * constant of its own, `<subpath>$<name>`, and prints how many (KT4 of r22b): a project that emits
 * declarations names each one's type, which a type exported from no subpath leaves unnameable (TS2742)
 */
export const REEXPORT_ALL = `import { writeFileSync } from "node:fs"
const specs = ${JSON.stringify(SUBPATHS)}
const lines = []
for (const [i, spec] of specs.entries()) {
	const names = Object.keys(await import(spec)).sort()
	const slug = spec === "@lovrozagar/comb" ? "root" : spec.slice("@lovrozagar/comb/".length).replaceAll(/[^a-z0-9]/gi, "_")
	if (names.length > 0) lines.push("import * as m" + i + " from " + JSON.stringify(spec))
	for (const name of names) lines.push("export const " + slug + "$" + name + " = m" + i + "." + name)
}
writeFileSync("src/reexport.ts", lines.join("\\n") + "\\n")
console.log(lines.filter((line) => line.startsWith("export ")).length)
`

/**
 * A module of the two checks a TypeScript below 5.7 dropped with no error under skipLibCheck (KT2
 * of r22b): each must stay an error at comb's floor, and below it the named imports fail instead
 */
export const FLOOR = `import { createUlidFactory } from "@lovrozagar/comb"
import { defineStateMachine } from "@lovrozagar/comb/states"
export const post = defineStateMachine({
	initial: "draft",
	transitions: {
		draft: ["live"],
		// @ts-expect-error "archivd" is no declared value
		live: ["archivd"],
	},
	values: ["draft", "live", "archived"],
})
// @ts-expect-error random fills bytes, not a string
export const ids = createUlidFactory({ random: (bytes: string) => void bytes.toUpperCase() })
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

/**
 * K3 of r21: comb's D1 modules in a Worker typed by `wrangler types` alone keep their types, the
 * binding's own: a wrong argument and an unknown method are each refused, which an untyped module,
 * as 0.19's was there, would let through; and a shard's handle is the env's own binding (K2 of r22)
 */
const C3_D1 = `import { BookmarkTracker } from "@lovrozagar/comb/sqlite/d1/bookmark"
import { drizzle } from "drizzle-orm/d1"
import { openD1Session } from "@lovrozagar/comb/sqlite/d1/session"
import { ShardRouter } from "@lovrozagar/comb/sqlite/d1/sharding"

export async function routed(env: Env, ctx: ExecutionContext, bookmark: string | undefined): Promise<string[]> {
	const { client, session } = openD1Session(env.DB, { bookmark })
	const tracker = new BookmarkTracker()
	tracker.track(session, "core")
	const router = new ShardRouter({ totalShards: 1 })
	const mapping = await router.resolve("org", { coreDb: env.DB, kv: env.KV }, ctx)
	await client.prepare("SELECT 1").run()
	/* K2 of r22: a shard's handle is the D1Database the generated Env holds, which drizzle takes */
	if (mapping) drizzle(router.getHandle(mapping, env).handle)
	// @ts-expect-error an env with no SHARD_DB_* binding holds no shard
	if (mapping) router.getHandle(mapping, { DB: env.DB, KV: env.KV })
	// @ts-expect-error a string is no D1 database
	openD1Session("not a database")
	// @ts-expect-error a D1 client has no such method
	client.nope()
	// @ts-expect-error the router's core database is a D1 database
	await router.resolve("org", { coreDb: "core", kv: env.KV }, ctx)
	// @ts-expect-error a tracked session is a D1 session
	tracker.track("session", "core")
	return [mapping?.target ?? "", ...tracker.getBookmarks().map((tagged) => tagged.bookmark)]
}
`

/** The files every staged consumer holds: the Worker, the types module, two tsconfigs, wrangler and vite config */
export const APP: Record<string, string> = {
	"src/count-eval.ts": COUNT_EVAL,
	"src/floor.ts": FLOOR,
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
		include: ["src/types.ts", "src/floor.ts"],
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
	/* declarations emitted for a module that re-exports every value comb exports: each type has a public name (KT4 of r22b) */
	"tsconfig.reexport.json": JSON.stringify({
		compilerOptions: {
			...STRICT,
			allowImportingTsExtensions: true,
			declaration: true,
			emitDeclarationOnly: true,
			module: "esnext",
			moduleResolution: "bundler",
			outDir: "decl-reexport",
			rootDir: "src",
		},
		include: ["src/reexport.ts"],
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
	/* everything bundled, so tooling that leaked into a runtime import would show in the output */
	"vite.config.mjs": `export default { build: { outDir: "dist-vite" }, ssr: { noExternal: true } }\n`,
	"wrangler.toml": 'name = "consumer"\nmain = "src/worker.ts"\ncompatibility_date = "2026-10-01"\n',
	/* a project create-cloudflare scaffolds, apart from the app's own files its src glob would take in */
	"c3/tsconfig.json": CREATE_CLOUDFLARE_TSCONFIG,
	/* the bindings `wrangler types` writes c3/worker-configuration.d.ts from, at the stage (K3 of r21) */
	"c3/wrangler.jsonc": JSON.stringify({
		compatibility_date: "2026-10-01",
		d1_databases: [
			{ binding: "DB", database_id: "00000000-0000-0000-0000-000000000000", database_name: "core" },
			{ binding: "SHARD_DB_0", database_id: "00000000-0000-0000-0000-000000000001", database_name: "shard-0" },
			{ binding: "SHARD_DB_1", database_id: "00000000-0000-0000-0000-000000000002", database_name: "shard-1" },
		],
		kv_namespaces: [{ binding: "KV", id: "00000000000000000000000000000000" }],
		main: "src/index.ts",
		name: "c3",
	}),
	"c3/src/index.ts": WORKER,
	"c3/src/d1.ts": C3_D1,
	"c3/src/types.ts": WORKER_TYPES,
	"c3/tsconfig.strict.json": JSON.stringify({ compilerOptions: STRICT_UNION, extends: "./tsconfig.json" }),
}
