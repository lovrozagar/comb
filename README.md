# Comb

Database framework for Cloudflare D1, PostgreSQL, and SQLite. Dialect-agnostic column builders on top of Drizzle, constraint-aware error mapping, D1 Sessions and sharding, a PostgREST-style list-query layer, schema codegen, and an Atlas-backed migration toolkit.

This repo is the source of the [`@lovrozagar/comb`](https://www.npmjs.com/package/@lovrozagar/comb) npm package. The CLI binary is `comb`.

This README is the full usage manual. An agent that reads only this file should be able to define tables, generate artifacts, run migrations, and serve list queries without opening source.

## Table of contents

- [What Comb is](#what-comb-is)
- [Install](#install)
- [First schema](#first-schema)
- [CLI](#cli)
  - [`comb codegen`](#comb-codegen)
  - [`comb migrate`](#comb-migrate)
- [Columns](#columns)
  - [SQLite factories](#sqlite-factories)
  - [PostgreSQL factories](#postgresql-factories)
  - [Constraints](#constraints)
  - [Patterns](#patterns)
- [Errors](#errors)
  - [`CombError`](#comberror)
  - [Constraint maps](#constraint-maps)
  - [Handlers](#handlers)
- [Codegen](#codegen)
  - [Config](#config)
  - [Generators](#generators)
  - [Analyzer](#analyzer)
- [Migrations](#migrations)
  - [Config and providers](#config-and-providers)
  - [Diff and apply](#diff-and-apply)
  - [Postgres](#postgres)
  - [SQLite transforms](#sqlite-transforms)
- [Query layer](#query-layer)
  - [Filter grammar](#filter-grammar)
  - [Sorting](#sorting)
  - [Sparse fieldsets](#sparse-fieldsets)
  - [Pagination and cursors](#pagination-and-cursors)
  - [Zod schemas](#zod-schemas)
  - [SQLite SQL generation](#sqlite-sql-generation)
  - [Translations](#translations)
- [Cloudflare D1](#cloudflare-d1)
  - [Sessions](#sessions)
  - [Bookmarks](#bookmarks)
  - [Sharding](#sharding)
- [Meta contract](#meta-contract)
- [Utilities](#utilities)
- [Package exports](#package-exports)
- [Repository layout](#repository-layout)
- [Develop](#develop)
- [Upgrading to 0.21](#upgrading-to-021)
- [Upgrading to 0.20.1](#upgrading-to-0201)
- [Upgrading to 0.20](#upgrading-to-020)
- [Upgrading to 0.19](#upgrading-to-019)
- [Upgrading to 0.18](#upgrading-to-018)
- [Upgrading to 0.17](#upgrading-to-017)
- [Upgrading to 0.16](#upgrading-to-016)
- [Upgrading to 0.15](#upgrading-to-015)
- [0.14.1](#0141)
- [Upgrading to 0.14](#upgrading-to-014)
- [Upgrading to 0.13.1](#upgrading-to-0131)
- [Upgrading to 0.13](#upgrading-to-013)
- [Upgrading to 0.12](#upgrading-to-012)
- [Upgrading to 0.11](#upgrading-to-011)
- [Upgrading to 0.10](#upgrading-to-010)
- [Upgrading to 0.9](#upgrading-to-09)
- [Upgrading to 0.8.0](#upgrading-to-080)
- [Upgrading to 0.7.0](#upgrading-to-070)
- [Upgrading to 0.6.1](#upgrading-to-061)
- [Upgrading to 0.6.0](#upgrading-to-060)
- [Upgrading to 0.5.0](#upgrading-to-050)
- [Releases](#releases)
- [License](#license)

## What Comb is

Comb sits on top of [Drizzle ORM](https://orm.drizzle.team). Drizzle stays the query builder and the runtime; Comb adds the parts a multi-dialect, multi-tenant application needs and Drizzle deliberately leaves open:

- **One column vocabulary across dialects.** `c.timestamp()`, `c.json()`, `c.id()` mean the same thing whether the table compiles to SQLite or PostgreSQL, so a table file can move between the two.
- **Constraint violations as domain errors.** A unique-index failure from D1, libsql, or Postgres becomes a single `CombError` with an `errorKey`, an HTTP status, and the offending table and column.
- **Codegen from the table files.** Codegen loads your Drizzle tables module and reads each table as drizzle built it, with the constraints Comb's column helpers recorded, and emits DTOs, Zod schemas, relations, FTS5 tables, column name maps, ER diagrams, and a typed ORM client.
- **Migrations with a safety rail.** Atlas produces the diff; Comb classifies it, makes it idempotent, hashes it, records it, rewrites SQLite's `foreign_keys` pragma dance into a `defer_foreign_keys` prelude, and guards a rebuild of a table other tables reference so its drop deletes none of their rows.
- **A list-query layer.** A PostgREST-style `filter`, `order`, `select` grammar parsed into an AST, validated against declared field types, and lowered to SQLite SQL with cursor pagination and FTS5 search.
- **D1 at scale.** The Sessions API for read-after-write consistency, bookmark tracking, and an org-to-shard router with a three-tier LRU → KV → core-D1 lookup.

Every layer is usable on its own. Nothing here requires an HTTP framework.

## Install

```bash
bun add @lovrozagar/comb drizzle-orm@1.0.0-rc.4 zod @noble/ciphers @noble/hashes
```

```bash
npm install @lovrozagar/comb drizzle-orm@1.0.0-rc.4 zod @noble/ciphers @noble/hashes
```

```bash
pnpm add @lovrozagar/comb drizzle-orm@1.0.0-rc.4 zod @noble/ciphers @noble/hashes
```

Comb ships TypeScript source, not a build, and the declarations a type checker reads. Your bundler or runtime compiles the source; your `tsc` and editor read the declarations under `types/`, so your project needs no tsconfig flag for comb, and your strict flags check your code, not comb's. Go-to-definition still opens comb's source, through the declarations' maps.

| Runtime or tool | Supported | How                                                                                                                                             |
| --------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun             | yes       | runs the source directly                                                                                                                        |
| `tsx`           | yes       | runs the source on Node                                                                                                                         |
| Vite            | yes       | bundles it; set `ssr.noExternal` for an SSR or Worker build                                                                                     |
| Wrangler        | yes       | bundles it into the Worker                                                                                                                      |
| `tsc`, editors  | yes       | TypeScript 5.7 or later reads the declarations under `types/`, in any `moduleResolution` that reads `exports` (`bundler`, `node16`, `nodenext`) |
| plain Node      | no        | type stripping refuses TypeScript in dependencies (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`); run it through `tsx` or a bundler            |

The consumer suite (`bun run test:consumers`) checks each supported row in CI: it installs the packed tarball, imports every subpath under Bun and `tsx`, builds with Vite and Wrangler, compiles every subpath with `tsc` under strict flags in a `bundler` and a `nodenext` project and on TypeScript 5.7.2, comb's floor, checks that TypeScript 5.6 fails at each import of comb, and type-checks a stock create-cloudflare Worker, its tsconfig verbatim, from the declarations alone. An install that skipped packing, such as a `file:` or link install of this repository or a git dependency, has no `types/`; `tsc` then reads the source, as before 0.19, which needs `allowImportingTsExtensions`.

The runtime subpaths (all but `cli`, `codegen` and `migrate`) type-check at `lib` ES2022, the floor create-cloudflare's templates give; the tooling subpaths, which run under Bun or Node, need ES2023.

Peer dependencies:

| Package          | Range                                    | Required                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drizzle-orm`    | `1.0.0-rc.4 \|\| 1.0.0-rc.5 \|\| ^1.0.0` | yes — the relational API (`defineRelations`) is v1-only                                                                                                                                                                                                                                                                         |
| `zod`            | `>=4.6.0 <5`                             | yes — every schema module builds on it                                                                                                                                                                                                                                                                                          |
| `@noble/ciphers` | `>=2.0.0 <3`                             | yes — cursors are sealed with its XChaCha20-Poly1305                                                                                                                                                                                                                                                                            |
| `@noble/hashes`  | `>=2.0.0 <3`                             | yes — the cursor key is derived with its HKDF-SHA256                                                                                                                                                                                                                                                                            |
| `ts-morph`       | `>=28.0.0 <29`                           | only for codegen (resolves imports, and loads TypeScript under node), and for `comb migrate diff` on a SQLite database whose comb.config.ts declares FTS, to read its tables file                                                                                                                                               |
| `typescript`     | `>=5.7.2`                                | only to type-check against comb: the declarations under `types/` need TypeScript 5.7 or later, and 5.6 fails at each import of comb                                                                                                                                                                                             |
| `@libsql/client` | `>=0.17.4 <0.18`                         | only for `comb migrate apply`, `baseline`, `check` and `status` on libsql and Turso                                                                                                                                                                                                                                             |
| `drizzle-kit`    | `1.0.0-rc.4 \|\| 1.0.0-rc.5 \|\| ^1.0.0` | only for `comb migrate diff`, which runs `drizzle-kit export`                                                                                                                                                                                                                                                                   |
| `wrangler`       | `>=4.147.0 <5`                           | only for `comb migrate apply`, `baseline`, `check` and `status` on D1, which wrangler applies                                                                                                                                                                                                                                   |
| `libpg-query`    | `>=17.7.4 <18`                           | only for `comb migrate apply`, `baseline`, `check` and `diff` on Postgres: comb reads each statement with it                                                                                                                                                                                                                    |
| `postgres`       | `>=3.4.9 <4`                             | only for `comb migrate baseline` on Postgres, to read what Atlas OSS leaves out, and for `check` to replay the history and the pending files on a postgres:// devUrl (without it, check rates the files alone and says so), and for `apply` to sweep what a killed check left on a postgres:// devUrl's server                  |
| `atlas`          | `>=1.2.0 <2`                             | only for `comb migrate apply`, `baseline`, `check` and `diff` on bun:sqlite, libsql and Turso; `comb migrate apply`, `check` and `diff` on D1; `comb migrate apply`, `baseline`, `check`, `diff` and `status` on Postgres: no package ships it, so install it from [atlasgo.io](https://atlasgo.io/getting-started) onto `PATH` |

The D1 modules (`sqlite/d1/*`) take a D1 binding, or a session of one, by the methods they call, and hand a session back in the binding's own type, so a Worker typed by `wrangler types` and one typed by `@cloudflare/workers-types` both use them, and comb needs neither.

Each range stops before the next breaking release, and comb refuses an optional peer outside its range, naming the version it found, so comb never runs on a major it was not tested against. comb finds `wrangler` and `drizzle-kit` in the project, from the working folder up, the way Node finds a package, and runs the one it checked by its own bin path: `wrangler` on `node`, and `drizzle-kit` on the runtime running comb (Bun from the `comb` binary, Node under `runCli` in a Node process), so neither needs to be on `PATH`, and in a workspace comb runs the copy the workspace itself installed. Each `comb migrate` command names every optional peer it needs and lacks before it connects, fetches, starts a process or asks Atlas anything, with one install line whose quoted ranges land inside comb's (`bun add <peer>` alone takes the newest release, which may be the next major). Atlas is one of them: comb reads `atlas version` first, and refuses an Atlas missing from `PATH` or outside `>=1.2.0 <2` in the same refusal, with its install page, as it refuses a SQLite `diff` whose comb.config.ts declares FTS without `ts-morph`. Drizzle's ranges name each tagged release candidate, 1.0.0-rc.4 and 1.0.0-rc.5, which the consumer suite type-checks comb against one by one, then `^1.0.0`, not a `>=` range: drizzle also publishes a `1.0.0-rc.N-<hash>` build of every branch, which a `>=1.0.0-rc.4` range admits and ranks above the tagged one, and its `latest` tag is still 0.x, so the install lines pin `drizzle-orm@1.0.0-rc.4`.

Comb's schemas are plain Zod; none is compiled. A Worker refuses the code a compiled schema builds (`new Function`), so there the compiler only added to the bundle. A Node or Bun app that wants compiled parsing opts in with `import "zod/compile"` as the first import of its entry: every schema built after it, comb's included, compiles on its first parse, and one the compiler cannot take keeps Zod's own parser. Zod 4.5.4 is the first release with that import.

The migration toolkit also shells out to [Atlas](https://atlasgo.io) `>=1.2.0 <2`, which no package ships: `comb migrate diff`, `check` and `apply` need it on `PATH`, `baseline` too on every provider but D1, and `status` on Postgres. When the project has no `drizzle-kit` or `wrangler` in range, comb names the package, its range and the install; when `node` is missing to run `wrangler`, comb names it.

## First schema

Define a table with Comb's column factories instead of Drizzle's raw ones.

```ts
/* src/db/core.tables.ts */
import { sqliteTable, index } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
import { patterns } from "@lovrozagar/comb/sqlite/patterns"
import * as z from "zod"

/* a c.json schema is exported, so the generated DTOs can import it, and is the stored document:
   no transform, pipe or preprocess, and no null on a NOT NULL column */
export const authorSettings = z.object({ digest: z.boolean() })

export const author = sqliteTable(
	"author",
	{
		id: c.id("aut"),
		email: c.text("email", { max: 254, email: true, lowercase: true, trim: true }),
		display_name: c.text("display_name", { min: 2, max: 64, trim: true }),
		locale: c.text("locale", { pattern: patterns.LOCALE }),
		settings: c.json("settings", authorSettings),
		created_at: c.createdAt("created_at"),
		updated_at: c.updatedAt("updated_at"),
		deleted_at: c.deletedAt("deleted_at"),
	},
	(t) => [index("idx_author_email").on(t.email)],
)

export const post = sqliteTable("post", {
	id: c.id("pst"),
	author_id: c.ref("author_id").references(() => author.id),
	status: c.enum("status", ["draft", "scheduled", "published"]).notNull().default("draft"),
	title: c.text("title", { max: 200, trim: true }),
	minute_read: c.integer("minute_read", { min: 1, max: 120 }),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
})
```

The second argument to each factory is a **constraint object**. At runtime most of it is inert — `c.text("title", { max: 200 })` just becomes `text("title", { length: 200 })` — and the helper records it on the column for codegen, which turns `{ min: 2, max: 64, trim: true }` into a Zod schema, a CHECK constraint, and an OpenAPI description. Constraints live next to the column, once. Codegen loads the tables module, so a constraint value is whatever the module computes: a constant (`pattern: patterns.E164_PHONE`, `max: NAME_MAX`), an enum member, an object spread over another, a constraint object passed by name, or an enum list built by a call. Each value must be a boolean, a number or a string; `pattern` is a `/source/flags` string.

Point a config at the file:

```ts
/* comb.config.ts */
import { defineCodegenConfig } from "@lovrozagar/comb/codegen"

export default defineCodegenConfig({
	databases: {
		core: {
			dialect: "sqlite",
			driver: "d1",
			tables: "./src/db/core.tables.ts",
			output: { default: "./src/db/_gen" },
		},
	},
})
```

Generate:

```bash
bunx comb codegen core
```

## CLI

```text
comb — database codegen + migration toolkit

COMMANDS:
  codegen [db...]           Run codegen for the databases in comb.config.ts (all, or those named)
  codegen --tables <path>   Direct mode: analyze one tables file and generate beside it
  migrate init              Create drizzle.config.ts and atlas-migrations/
  migrate diff <db> [name]  Diff the schema and write the next migration
  migrate check <db>        Check and approve the pending migrations, applying nothing
  migrate apply <db>        Apply pending migrations: approve drops, apply and record each at once
  migrate baseline <db>     Record the migrations a database already reflects as applied
  migrate status <db>       Show a database's applied and pending migrations

OPTIONS:
  -g, --generator <name>  Run one generator only [codegen]
  --tables <path>         Analyze this tables file directly, no comb.config.ts [codegen]
  -e, --env <name>        Environment from comb.migrate.config.ts [migrate apply, migrate baseline, migrate check, migrate diff, migrate status]
  --dir <path>            Migrations directory (default: the config's, else ./atlas-migrations) [migrate apply, migrate baseline, migrate check, migrate status]
  --dialect <name>        The project's dialect: sqlite (default) or postgres [migrate init]
  --dry-run               Write nothing: exit 1 printing the migration a diff would write, 0 in sync [migrate diff]
  --file <path>           Apply this one migration file [migrate apply]
  -y, --yes               Approve cautious changes without asking (not unsafe ones) [migrate apply, migrate check]
  --local                 Without a migrate config: the local D1 (wrangler --local) [migrate apply, migrate baseline, migrate check, migrate status]
  --hashes                On D1: record the current hash of each applied file that has none (check the files against git first) [migrate baseline]
  --json                  Print one JSON object (database, applied, pending, refused, unknown) as the only stdout [migrate apply, migrate check, migrate status]
  -h, --help              Show this help
  --version               Print comb's version
```

The binary requires Bun — the shebang is `#!/usr/bin/env bun`, and `comb migrate diff` runs the project's `drizzle-kit` bin on the runtime running comb, Bun here.

The CLI is tested on Linux and macOS (CI runs its loader, codegen and SQLite-family migrate suites on both, with real Atlas) and relies on POSIX process groups, so Windows is not supported: `comb codegen` loads each tables module in a child of its own process group, which a supervisor kills whole, with every process the module started, after 60 s or when the run is interrupted. The library itself (columns, queries, error handling) runs wherever its database driver does.

External tools the migration commands shell out to, none of them install-time dependencies: [Atlas](https://atlasgo.io) `>=1.2.0 <2` on `PATH`, and the project's own `drizzle-kit` and `wrangler`, `wrangler` authenticated against the account for a remote D1 database. Each command needs these, on the providers named; the npm clients a provider's commands load are in the peer dependencies table.

| Command                          | Needs                                                               |
| -------------------------------- | ------------------------------------------------------------------- |
| `migrate diff`                   | `atlas` and `drizzle-kit`                                           |
| `migrate check`, `migrate apply` | `atlas`; `wrangler` on D1                                           |
| `migrate baseline`               | `atlas` on bun:sqlite, libsql, Postgres and Turso; `wrangler` on D1 |
| `migrate status`                 | `atlas` on Postgres; `wrangler` on D1                               |

The D1 provider drives `wrangler d1 execute` and `wrangler d1 migrations apply` as child processes, against the remote database by default; set `local: true` in its provider config, or pass `--local` without a migrate config, to target the local dev database. `wranglerConfig` (relative to `comb.migrate.config.ts`; default: the wrangler config beside it) and `wranglerEnv` name the wrangler config that binds the database and its environment, and comb passes them as `--config` and `--env` to every wrangler command. Wrangler is given the provider's `databaseName`, a binding or a `database_name` of that config, whatever the environment is called; a binding is the safer choice, since a bare name can reach an unrelated D1 that shares it.

### `comb codegen`

```bash
# every database in comb.config.ts
bunx comb codegen

# one database
bunx comb codegen core

# one generator
bunx comb codegen core -g dtos

# no config file — analyze a tables file directly
bunx comb codegen --tables ./src/db/core.tables.ts
```

Config mode reads `comb.config.ts` (or `.js`) from the working directory. Direct mode skips the config and writes next to the tables file, which is useful in a scratch repo or a test.

### `comb migrate`

| Dialect                          | `diff` writes the next migration with                                                       | `apply` and `baseline` run through                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| SQLite, libsql, Turso            | Atlas on an in-memory SQLite, plus comb's FTS5 part                                         | comb: each file and its hash in one batch, recorded in `__drizzle_migrations`                         |
| D1                               | Atlas on an in-memory SQLite, plus comb's FTS5 part                                         | comb checks, then `wrangler d1 migrations apply` applies and records in the binding's `d1_migrations` |
| Postgres (plain, Neon, Supabase) | Atlas on the dev database, plus comb's part for what Atlas OSS refuses (views, policies, …) | Atlas, after comb snapshots, classifies and approves each file; recorded in `atlas_schema_revisions`  |

`init` scaffolds `drizzle.config.ts` and `atlas-migrations/`, and no `atlas.hcl`: comb runs Atlas with a config of its own, and comb's unsafe gate, not an Atlas `skip` block, is what stops a drop. Delete an `atlas.hcl` an earlier `init` wrote; `init --dialect postgres` adds a `comb.migrate.config.ts` whose URL comes from `DATABASE_URL`, and no file holds a credential. `check` runs the check every apply runs first and applies nothing; it reads the database's history, so it needs the database. `baseline` adopts a database that already has the schema: it records the migrations as applied without running any, but only once the database's schema is the one they leave (on D1, only the files comb 0.7's `__drizzle_migrations` records). `status` lists a database's applied and pending migrations. `diff --dry-run` writes nothing: it exits 0 when the schema is in sync, and 1 printing the migration a diff would write.

## Columns

### SQLite factories

`@lovrozagar/comb/sqlite/columns` exports `c`:

| Factory                              | Emits                                               | Notes                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `c.id(prefix)`                       | `text("id").primaryKey()`                           | `prefix` is type-erased metadata; codegen uses it for `generateId()`, and `c.id` throws for one `generateId` refuses (2–10 lowercase letters and digits, a letter first) |
| `c.serialId()`                       | `integer("id").primaryKey({ autoIncrement: true })` |                                                                                                                                                                          |
| `c.text(name, constraints?)`         | `text(name)`                                        | `max` becomes `{ length: max }`                                                                                                                                          |
| `c.integer(name, constraints?)`      | `integer(name, { mode: "number" })`                 |                                                                                                                                                                          |
| `c.real(name, constraints?)`         | `real(name)`                                        |                                                                                                                                                                          |
| `c.boolean(name)`                    | `integer(name, { mode: "boolean" })`                |                                                                                                                                                                          |
| `c.enum(name, values)`               | `text(name).$type<T[number]>()`                     | `values` is type-erased; codegen emits the CHECK                                                                                                                         |
| `c.json(name, schema, constraints?)` | `text(name, { mode: "json" }).$type<z.infer<S>>()`  |                                                                                                                                                                          |
| `c.ref(name)`                        | `text(name)`                                        | chain `.references(() => other.id)`                                                                                                                                      |
| `c.timestamp(name, constraints?)`    | `integer(name, { mode: "number" })`                 | epoch milliseconds                                                                                                                                                       |
| `c.createdAt(name)`                  | non-null, defaults to `unixepoch() * 1000`          | name must be `createdAt` or `created_at`                                                                                                                                 |
| `c.updatedAt(name)`                  | non-null, with `$onUpdate`                          | name must be `updatedAt` or `updated_at`                                                                                                                                 |
| `c.deletedAt(name)`                  | nullable timestamp                                  | name must be `deletedAt` or `deleted_at`                                                                                                                                 |

Timestamps are integer milliseconds, not SQLite's `TEXT` dates — comparisons, cursors, and index ranges all stay numeric.

### PostgreSQL factories

`@lovrozagar/comb/pg/columns` exports the same `c` shape backed by `drizzle-orm/pg-core` (`text`, `integer`, `serial`, `boolean`, `jsonb`, `doublePrecision`). Timestamps (`createdAt`, `updatedAt`, `deletedAt`, `timestamp`) are `bigint` epoch milliseconds read as JS numbers: a 4-byte `integer` overflows on today's time. A table file written against Comb's `c` compiles under either dialect by swapping the import.

### Constraints

The constraint object is shared by both dialects. `@lovrozagar/comb/sqlite/constraints` types them:

| Key                              | Applies to          | Effect                                                                                                                                                                                                                       |
| -------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `min` / `max`                    | text, integer, real | length or numeric bounds                                                                                                                                                                                                     |
| `maxBytes`                       | json                | UTF-8 byte bound on the serialized value, on writes                                                                                                                                                                          |
| `pattern`                        | text                | regex, as a source-level string                                                                                                                                                                                              |
| `email` / `url`                  | text                | an email checked by zod's email pattern, which publishes; a url by the WHATWG URL parser, https only, its https pattern published; neither publishes a `format`                                                              |
| `trim`, `lowercase`, `uppercase` | text                | transforms applied in generated schemas                                                                                                                                                                                      |
| `password`                       | text                | a stored password hash: kept as written, held to its declared bounds and pattern alone; `passwordText()` holds the plaintext                                                                                                 |
| `private`                        | any                 | omitted from generated read DTOs, from every published list and from every error; a column whose property name starts with `_` is private without it                                                                         |
| `nomutate`                       | any                 | set on create, then never: omitted from the generated update DTO                                                                                                                                                             |
| `mutable`                        | a foreign key       | moves after creation: in the generated update DTO, where every other reference is set once; refused elsewhere, with `nomutate` and with `tenant`                                                                             |
| `tenant`                         | any                 | the table's tenant scope, published as `tenantColumn`: set once, on create, whatever it references, so it is out of the generated update DTO and `immutable`; one per table                                                  |
| `relation: "…"`                  | a foreign key       | names the key's relation and its way back, where the column's role would take a column's own name (`currency` toward `currency.code`, a `parent` self-reference); an identifier, refused on a column that references nothing |
| `autogenerate`                   | any                 | server-assigned, omitted from create/update DTOs; defaults to `true` on `c.createdAt`, `c.updatedAt` and `c.deletedAt`, and on a timestamp-named column a default or `$onUpdate` fills, never by its name alone              |

A text takes one kind of `email`, `url`, `password`, `imageUri` and `name`, and no key its kind would drop, each a codegen failure: `uppercase` on an email, which is lowercased; `lowercase` or `uppercase` on a url, kept as written but for its trim; `trim` or a casing on a password, kept as written.

`private` and `nomutate` are the two that change generated output the most: a `password` column marked `private` never appears in a row DTO, and a `created_at` marked `autogenerate` never appears in a create DTO. A key comb or the database fills (`c.id`, `c.serialId`, an `autoIncrement` or defaulted key, SQLite's integer rowid key) is left out of create and update too, while a natural key the caller supplies stays required, whatever its name. The timestamp columns are never part of a create body, so a client backdates no row. A write takes an integer's declared `min` and `max`, clamped to what the column holds (int4 on Postgres, a JS number's exact range on SQLite); a count that may not go negative declares `{ min: 0 }`. A written text is held to its declared bounds and to comb's own together: a required text's minimum of 1, an https URL's 9 characters at least; codegen fails, naming the column, when they leave no value, as it does for an integer's. A read never refuses a stored row, which an older rule, a migration or an import may have stored past a bound: it holds a value only to what the engine holds the column to (a Postgres varchar's length, int2 or int4's range, a JS number's exact range, an enum's values), and states each declared bound, a `c.id`'s length of 1 to 48 and a SQLite text length among them, as `x-comb-minLength`, `x-comb-maxLength`, `x-comb-minimum` or `x-comb-maximum` in its JSON Schema. A text reference keeps its own bounds; a `c.ref` takes the id's when its target is a `c.id` key or it names none, as a reference to another database's key, and its own text rules when it names a non-id column. A write refuses U+0000 and an unpaired surrogate in text and in JSON, on both dialects, as no engine stores them as sent; a written text's `trim`, `lowercase` and `uppercase` rewrite it before its checks, which the JSON Schema lists, in order, as `x-comb-transform` (an email's is `["trim", "lowercase"]`), its bounds and pattern binding the rewritten value; the rule is a refine, which the JSON Schema states as `x-comb-text` (and a JSON byte limit as `x-comb-maxBytes`), never as a pattern, so a field's own `pattern` stays its pattern and a `c.json` field a `$ref` to its schema. A nullable field's keys sit on the property and on its non-null member alike, so a field taken as a required input with zod's `.unwrap()` keeps them, as `.optional()`, `.pick()` and `.extend()` do (meta-contract §2.1). The rule is `isStorableText(s)` from the package root, which the generated files import; `storableText()` from there is `z.string()` under the same refine and `x-comb-text`, for a text field of your own schema, a `c.json` document's or a request body's, that is stored as sent. The `imageUri` and `url` (https) rules are regexes, so the JSON Schema publishes them as patterns, and each OpenAPI example satisfies its field's bounds; a field with a `pattern` gets none.

### Passwords

A `password` column holds the hash, so its DTO takes any storable hash: bcrypt's 60 characters, an argon2id PHC string or a PBKDF2 one, at least 1 character when the column is required, under the `max` and `pattern` it declares (`pattern: "/^\\$argon2id\\$/"` holds the hash to its scheme) and no limit of comb's. The plaintext is the request body's, before it is hashed: `passwordText()` from the package root holds it to NIST SP 800-63B rev 4 §3.1.1.2.

```ts
import { passwordText } from "@lovrozagar/comb"
import * as z from "zod"

const signUp = z.object({ email: z.email(), password: passwordText() })
const signIn = z.object({ email: z.email(), password: passwordText.typed() })
```

`passwordText()` sets a password: any storable text of 15 to 128 characters, counted by code point, with no composition rule and nothing trimmed. A password used only beside a second factor may take `passwordText({ min: 8 })`, as rev 4 allows; `min` and `max` are yours to set. `passwordText.typed()` reads one typed to sign in and holds only the max, so a password set under an older or shorter minimum still signs in. Both normalize the value to NFC before they count it, and give the NFC string, so a password typed in another normalization hashes to the same value; an app that adopts it over hashes made from input it never normalized rehashes each one on its next successful sign-in. Under `{ hash: "bcrypt" }` both refuse past 72 UTF-8 bytes, which bcrypt reads no further than, and publish `x-comb-maxUtf8Bytes: 72`, the string's own bytes (`x-comb-maxBytes` is a JSON text's); `passwordText({ hash: "bcrypt", min })` with a `min` past 72 throws, as no password would pass it. The JSON Schema states the rewrite as `x-comb-transform: ["nfc"]` and the bounds as `minLength` and `maxLength`, which count the NFC form's code points, and a password out of bounds is zod's own `too_small` or `too_big` issue with its `minimum` or `maximum`, bcrypt's bytes included.

### Patterns

`@lovrozagar/comb/sqlite/patterns` ships regexes as source-level strings so the codegen parser can copy them verbatim into `.regex()` calls:

```ts
import { patterns } from "@lovrozagar/comb/sqlite/patterns"

patterns.COUNTRY_ALPHA2 // "/^[A-Z]{2}$/"
patterns.E164_PHONE // "/^\\+[1-9][0-9]{7,14}$/"
patterns.IANA_TIMEZONE // "/^[A-Za-z_/]+$/"
patterns.LOCALE // "/^[a-z]{2}(-[A-Z]{2})?$/"
```

## Errors

### `CombError`

<!-- ts-context
declare const original: unknown
-->

```ts
import { CombError, combErrorKeys } from "@lovrozagar/comb"

throw new CombError({
	errorKey: combErrorKeys.UNIQUE_CONSTRAINT_VIOLATION,
	status: "conflict",
	table: "author",
	column: "email",
	cause: "Email already registered",
	source: original,
})
```

`status` is a `StatusKey`, not a number — `bad_request`, `conflict`, `forbidden`, `unprocessable_entity`, `internal_server_error`, `service_unavailable`. The numeric `.status` is derived from it, so an HTTP layer can read `.status` and a log layer can read `.statusKey`.

Built-in keys (`combErrorKeys`): `CHECK_CONSTRAINT_VIOLATION`, `CONSTRAINT_VIOLATION`, `CURSOR_NOT_WIRED`, `CURSOR_PAGINATION_UNSUPPORTED`, `DATABASE_IO_ERROR`, `DATABASE_READONLY`, `DATABASE_UNAVAILABLE`, `EXCLUSION_CONSTRAINT_VIOLATION`, `FILTER_NOT_WIRED`, `FOREIGN_KEY_VIOLATION`, `INVALID_CURSOR`, `INVALID_PAGE`, `INVALID_SELECT`, `INVALID_STATE_TRANSITION`, `INVALID_VALUE`, `PAGE_NOT_WIRED`, `PAGE_TOO_DEEP`, `PRIMARY_KEY_VIOLATION`, `REQUIRED_FIELD_MISSING`, `SEARCH_NOT_WIRED`, `SHARDS_FULL`, `SORT_NOT_WIRED`, `STORAGE_LIMIT_REACHED`, `UNIQUE_CONSTRAINT_VIOLATION`, `VALUE_TOO_LARGE`. `combDatabaseErrorKeys` lists the subset the database classifiers (`classifyD1Error`, `classifySqliteError`, `classifyPgError`) answer with, for a map of database errors to iterate.

`SHARDS_FULL` (503) means no shard has room for a new organization: provision another D1 database.

### Constraint maps

A constraint map turns a constraint violation into your domain's error, keyed by what every dialect's message lets the handler read: a unique by its columns' SQL names, comma-joined (`email`, `org_id,slug`); a unique index on an expression by its index name; a foreign key by its first column's SQL name; a CHECK, and on Postgres an exclusion, by its constraint name. SQLite and D1 report a plain unique's columns and no foreign key's name, so a map keyed by those names works on Postgres alone; key it as codegen does. Their message names no foreign key at all, so their handler blames a `foreignKey` entry only where it is the one key the maps list for the table and the statement sets that column; any other foreign-key failure there is the generic 409. List every foreign key of the table, as codegen does: a key the map leaves out that fails beside the listed one is blamed on it:

```ts
import type { ConstraintMap } from "@lovrozagar/comb"

export const authorConstraints: ConstraintMap = {
	author: {
		unique: {
			email: {
				cause: "email",
				errorKey: "email_already_registered",
				statusKey: "conflict",
			},
		},
		foreignKey: {
			org_id: { cause: "org_id", errorKey: "org_not_found" },
		},
		check: {
			author_locale_check: { cause: "locale", errorKey: "locale_invalid", statusKey: "bad_request" },
		},
	},
}
```

`comb codegen -g constraints` writes this file from your table definitions, so each key always matches what the migration actually created. A CHECK enters the map from ``check("name", sql`…`)`` or `check("name", sql.raw("…"))`; a `check()` codegen cannot read, such as one named by a variable or built from a variable, fails the run with its file and line rather than be left out. A unique index on an expression, such as `lower(email)`, is keyed by its index name under `unique` on every dialect. On Postgres, an `exclusion` record maps an `EXCLUDE` constraint by name; without an entry its violation is a 409 `exclusion_constraint_violation`. `referenced` lists a table's columns that another table's foreign key points at, which codegen fills: on SQLite, whose message names no side, an `UPDATE` or an upsert's `DO UPDATE SET` that assigns one answers the neutral "Referenced record does not exist or is still in use", as it may have failed on a row that references the old value. A hand-written map should add it; without it the table's own key is blamed as before. On Postgres, `partitions` lists a partitioned table's partitions, which codegen fills from `comb.config.ts`'s `partitions`: Postgres reports a violation on the partition, and the map reads it as the parent's, under its keys and its `private` list. On every dialect, a violation on a table the maps given key nowhere, such as a partition left out or a table outside the schema a trigger writes, names no column, as no map can say which of its columns are private. A key ending in `*` is a prefix pattern for tables an app makes at run time, which no generated map can name: add `"ut_*": {}` beside the generated map, once at module load (`const MAPS = defineConstraintMaps({ ...DB_CONSTRAINT_MAP, "ut_*": {} })`), and every `ut_` table is known, its columns named, with the entry's `private` list and constraints if it has them. A table's own key wins over a pattern, and the longest pattern over a shorter one; a `*` anywhere but a key's end is a `TypeError`. `private` lists a table's private columns by SQL name, which codegen fills too: an error names none of them, so its `column` is unset and its cause generic ("Required field missing", "Duplicate value detected", "Invalid value"), and each constraint on one answers its table's own key for its kind, `<table>_duplicate`, `<table>_reference_not_found`, `<table>_value_invalid` or `<table>_check_failed`, which names neither the column nor the constraint. A map without the list names every column as before.

### Handlers

Three handlers, one signature — `(error: unknown, constraintMaps: readonly ConstraintMap[]) => void`. Each walks the error's `cause` chain past wrappers such as drizzle's `DrizzleQueryError`, reads the engine's own code, finds the matching map entry, and throws a `CombError`. If nothing matches, they return and let the original error propagate.

<!-- ts-context
declare const db: { insert(table: unknown): { values(row: unknown): Promise<unknown> } }
declare const author: unknown
declare const input: unknown
declare const authorConstraints: import("@lovrozagar/comb/types").ConstraintMap
-->

```ts
import { defineConstraintMaps } from "@lovrozagar/comb"
import { d1ErrorHandler } from "@lovrozagar/comb/sqlite/d1/error-handler"
import { pgErrorHandler } from "@lovrozagar/comb/pg/error-handler"
import { sqliteErrorHandler } from "@lovrozagar/comb/sqlite/constraint-handler"

/* once, at module load: a malformed key fails here, not at the first violation */
const MAPS = defineConstraintMaps(authorConstraints)

try {
	await db.insert(author).values(input)
} catch (error) {
	d1ErrorHandler(error, MAPS)
	throw error
}
```

Build the maps you pass once, at module load, with `defineConstraintMaps(...maps)` (from `@lovrozagar/comb`): it refuses, as a TypeError naming the key, a prefix pattern with its `*` anywhere but the end (`"ut_*_rows"`), so a typo fails at startup and in tests, never at the first violation. A handler given maps not built with it still answers each violation with its well-formed keys, and warns once per process (`comb.constraint-maps.error`, on `console.warn`) of each malformed key, which matches no table, however many arrays or maps carry it, a map spread per call included.

- `sqliteErrorHandler` — libsql, Turso and `bun:sqlite`. Classifies by SQLite's extended result code: the primary key by `SQLITE_CONSTRAINT_PRIMARYKEY`, a CHECK by its constraint name (in the statement's table first), a composite unique by its columns together, naming no one column, NOT NULL with its column. A duplicate rowid, an FTS5 table's included, is a primary key violation (409). It also maps `SQLITE_FULL` (422) and `SQLITE_BUSY` / `SQLITE_LOCKED` / `SQLITE_READONLY` (503).
- `d1ErrorHandler` — Cloudflare D1. Constraint violations go through the same SQLite mapping. Other errors with an SQLite code are query errors (500); a D1 platform failure without one is transient (503) or a storage limit (422).
- `pgErrorHandler` — PostgreSQL on node-postgres, postgres.js and Bun.SQL. Classifies by SQLSTATE (read from `code`, or Bun.SQL's `errno`) and reads `table`/`table_name`, `constraint`/`constraint_name` and `column`/`column_name` alike. The primary key is a 23505 on `<table>_pkey`.
- `handleConstraintViolation` — the constraint half of `sqliteErrorHandler`. It also accepts an engine message given as text.
- `classifySqliteError`, `classifyD1Error`, `classifyPgError` — the same answers without throwing: the `CombError` each handler would throw, or `undefined` when it would throw nothing, so code that expects one violation can ask instead of catching: `classifyD1Error(error, maps)?.errorKey === "project_member_taken"`.

A rule a trigger enforces is the same 400 `constraint_violation` on every engine, its cause the message the app raised: `RAISE(ABORT, 'qty must be positive')` on SQLite, libsql and D1 (`SQLITE_CONSTRAINT_TRIGGER`), and `RAISE EXCEPTION 'qty must be positive'` (P0001) on Postgres. Write that message for the client. On libsql over a network and on Turso, the cause is the generic "Constraint violated": the server sends a violation's bare code with no `_TRIGGER`, so a raised message cannot be told from SQLite's own words. For the same reason a primary key conflict there is the 409 `unique_constraint_violation` its words describe (`UNIQUE constraint failed: parent.id`), not `primary_key_violation`. Every other violation there reads as on a file, its status, map entry and column included.

Each handler answers a value the request sent that the column cannot hold from one shared table, so the same bad value is the same 400 on every engine. The answer names the column where the engine does, never the value: Postgres names none for text that is no number or a string past `varchar(n)` (22P02, 22001), so there the cause is a bare "Invalid value". `invalid_value` covers a string past `varchar(n)`, a number out of range, text that is no number, a NUL byte, a date that does not parse or is out of range, a time zone offset past 15:59, an interval past its range (SQLSTATE 22001, 22003, 22021, 22P02, 22P05, 22007, 22008, 22009, 22015), and a STRICT table's column given another type (`SQLITE_CONSTRAINT_DATATYPE`, `SQLITE_MISMATCH`). `value_too_large` covers a value too large for an index row (54000) and a string or blob past the engine's limit (`SQLITE_TOOBIG`, 2 MB on D1). A foreign-key violation from a delete or a key update of a row others still reference names the statement's table, the parent, on every engine, wherever the SQL is recorded (drizzle's error, postgres.js's own); a bare node-postgres error records none, and names no table.

A `CombError`'s `cause` is safe to show a client. The original error, which can hold the SQL and its bound values, is on `source`, which is never serialized; log it, don't return it.

## Codegen

### Config

```ts
/* comb.config.ts */
import { defineCodegenConfig } from "@lovrozagar/comb/codegen"

export default defineCodegenConfig({
	databases: {
		core: {
			dialect: "sqlite", // "sqlite" | "postgres"
			driver: "d1", // bun-sqlite | d1 | libsql | turso (sqlite) · neon (postgres)
			tables: "./src/db/core.tables.ts",
			filePrefix: "db.core", // generated file name prefix
			generators: ["dtos", "orm"], // omit to run all
			output: { default: "./src/db/_gen" }, // per generator too: { dtos: "./src/dtos" }
			fts: {
				post_translation: { columns: ["title", "body"], tokenizer: "porter unicode61" },
			},
		},
	},
})
```

A Postgres database lists its partitioned tables under `partitions`, each keyed as its constraint map keys it (`audit`, or `app.audit` for a `pgSchema` table) to its partitions' names, which live in its schema: `partitions: { audit: ["audit_2026", "audit_2027"] }`. Codegen refuses a key that is no table, a partition that is a table or is listed twice, and any on SQLite. A partition not yet listed fails closed: its violations name no column until codegen lists it.

`defineCodegenConfig` types the file, so a mistyped generator, `output` key or driver fails to compile, and comb holds the file to a strict schema as it loads it, so a key it does not know, which a config built through a helper of your own passes the compiler with, is refused by name, with the file and where (`comb.config.ts is not a valid comb config: ✖ Unrecognized key: "filePrefx"`), never run on its default. `output.default` is the directory every generator writes to unless the config names its own output; without it, files go beside the tables file.

Under `isolatedDeclarations`, the constraints, entities, enum-checks, error-keys, field-names, rows, rqb-cols, sql-cols and table-names files compile; the DTO files and `_shared`, `relations.gen.ts` and `orm.gen.ts` infer their zod and drizzle types, as your tables module does, so keep them in a tsconfig without the flag (meta-contract §10).

A run writes nothing until every database's generators succeed, then writes them all at once, so a failing database leaves the others' files and `package.json` as they were. It then deletes what each database's last run wrote and no database wrote this time, but only files carrying comb's own header (`@generated by comb`, or a JSON `_generated` value starting `comb `); another tool's generated file is refused like a file of your own. A table that was removed, a `filePrefix` that changed and an `output.default` that moved all count, and a run of the whole config (no database named, no `-g`) also deletes the files of a database the config no longer declares. Two databases that would write one path fail the run, naming both. In `package.json`, codegen owns `./tables`, `./relations` and the `./dtos/*` subpaths that point at its own generated files; your own `./dtos/*` entries stay. The record of what each database wrote is `.comb.codegen.gen.json` beside `comb.config.ts`, named under the `.gen.` convention formatters ignore (beside the tables file in `--tables` mode); commit it with the output. A database's name becomes the stem of generated identifiers, camel-cased across any character an identifier cannot hold (`my-db` gives `createMyDbDb` and `MY_DB_DB_CONSTRAINT_MAP`); a name that still makes no identifier fails the run. Without a `dialect` in the config, the drizzle builder each table's file imports decides it (`pgTable` or `sqliteTable`, through any re-export), and a database holding both is refused, as is a config `dialect` its tables contradict.

### Generators

`@lovrozagar/comb/codegen/generators` exports each one directly; the CLI runs them by name via `-g`.

| Generator      | Output                                                        |
| -------------- | ------------------------------------------------------------- |
| `columns`      | column name constants, so query code never hard-codes strings |
| `constraints`  | the `ConstraintMap` for the error handlers                    |
| `diagrams`     | Mermaid ER diagrams                                           |
| `dtos`         | Zod schemas and TypeScript DTOs for create, update, and read  |
| `entities`     | `generateId()` helpers bound to each table's id prefix        |
| `enum-checks`  | SQL CHECK constraints for `c.enum()` columns                  |
| `field-names`  | typed field-name unions for the query layer                   |
| `fts`          | FTS5 metadata map                                             |
| `fts-sql`      | FTS5 virtual tables, triggers, and backfill SQL               |
| `orm`          | a typed `createXDb(handle)` client wired to the driver        |
| `relations`    | Drizzle v1 `defineRelations()` from the foreign keys          |
| `rows`         | row types inferred from the tables                            |
| `translations` | helpers for `*_translation` sibling tables                    |

Every generated file opens with a checksum header:

```ts
/* @generated by comb — do not edit. checksum: bb552c750aeb */
```

Writes are atomic (temp file plus rename) and skipped when the checksum is unchanged, so codegen is safe to run on every build and produces no spurious diffs.

A generated file's relative imports follow the tsconfig nearest the tables file: under `node16` or `nodenext` each names its extension, `.js` for a TypeScript file, or the `.ts` itself under `allowImportingTsExtensions` or `rewriteRelativeImportExtensions`; under `bundler` and the older resolutions, none, as before.

A plain drizzle column, built with no `c` helper, is typed by its data type. On Postgres its create and update DTOs take what Postgres takes for that type, so a value the database would refuse is a 400 from the DTO, not a 22P02 from the insert: a `uuid` is `z.guid()`; a `date` an ISO date, as `z.iso.date()` takes one, from year 0001, as Postgres holds one; a `timestamp` a local date-time and a `timestamptz` one with its offset, so neither loses the instant; a `time` an ISO time, as `z.iso.time()` takes one, and a `timetz` the same with its offset, its precision included (`time(3) with time zone`); an offset written as RFC 3339 writes one, `Z` or `±hh:mm`, as JSON Schema's `time` and `date-time` formats name it, at most 15:59 either way, as Postgres holds one; a precision on a time, a timestamp or an interval no longer fraction of a second, which Postgres would round (`timestamp(0)` rounds `23:59:59.6` into the next day); an `interval` an ISO 8601 duration, each part at most the digits whose every value Postgres holds (a sum of parts past its range is the handler's 400), with no part below its fields' last (`PT1H` into an `interval day`, which Postgres stores as 0, is refused); a `numeric(p, s)` decimal digits within its precision and scale, a scale past the precision a fraction alone and a scale below 0 a whole number ending in that many zeros, nothing Postgres would round, and in number mode a number Postgres's rounding keeps within them; a string-mode `bigint` digits within int8; a `real` a number float4 holds and does not round to zero; an `inet` an address, its netmask optional; a `cidr` the same with no bit set past its prefix length, through `isCidr` from the package root; a `macaddr` or `macaddr8` any spelling Postgres takes with no blank in it and nothing after its last octet; a `bit(n)` exactly n bits. A few spellings Postgres also takes are refused for the canonical one (a date's `tomorrow`, `24:00:00`, a numeric exponent, a non-ISO interval, since 0.15 a uuid in braces or as bare digits, and since 0.21 an IPv6 address with a colon before its prefix or an empty part in its IPv4 tail, and an interval part of more digits than that, such as `PT2562047788H`; the 0.14, 0.15 and 0.21 changelogs list each). A read DTO keeps the plain type, as a read never refuses a stored row, with one exception: a float column reads back `Infinity` and `-Infinity`, which JSON writes as `null`, and the `null` D1 hands an infinity back as, and its published JSON Schema takes that `null` (`anyOf: [{ type: number }, { type: null }]`, typed `number | null`), but on Postgres a stored `NaN` fails the read DTO, since JSON Schema cannot represent it (SQLite stores a NaN as NULL). A data type comb has no rule for (a `sparsevec`, a buffer, a date mode) fails codegen, naming the column and the types comb does type.

### Analyzer

```ts
import { analyze, validateTables } from "@lovrozagar/comb/codegen"

const result = await analyze("./src/db/core.tables.ts")
const { errors, warnings } = validateTables(result)
```

`analyze()` returns a promise of an `AnalysisResult` — `TableMeta` per table with `FieldMeta`, `FieldConstraintsMeta`, `ForeignKeyRef`, `UniqueIndexMeta`, `CheckConstraintMeta`, and `TimestampsMeta`. It loads the tables module and reads every table it exports as drizzle built it (`getTableConfig`) and as the `c` helpers recorded it, so a bound, an enum list or an id prefix is the value the module computes, however its source spells it. The module runs in a child process on the runtime codegen runs on, with only `PATH`, `HOME` and `NODE_OPTIONS` in its environment, comb's own working directory (where the config is, or where you run it with `--tables`; `analyze()` takes `{ cwd }`), as the app and drizzle-kit run it, and 60 seconds to load, so a tables module must be import-safe, as drizzle-kit already needs it to be: no connection, no secret read, no work at import. Under node the child loads TypeScript itself, resolving imports as the nearest `tsconfig.json` does (`paths` included); bun does that natively. A module that fails to load, a column comb cannot type, a `c.json` schema no module exports, or a key into a table the tables file does not export fails codegen, naming the file, the table and the column.

`validateTables()` checks an analysis before the generators run: names and id prefixes two tables may not share, one tenant column per table, state machines against their values, and primary keys a cursor can page.

## Migrations

### Config and providers

```ts
/* comb.migrate.config.ts */
import { defineConfig } from "@lovrozagar/comb/migrate"

export default defineConfig({
	databases: {
		core: {
			migrationsDir: "./atlas-migrations",
			drizzleConfigPath: "./drizzle.config.ts",
			provider: { type: "bun-sqlite", path: "./.comb/core.db" },
			environments: {
				prod: {
					name: "prod",
					provider: { type: "d1", databaseName: "core" },
				},
			},
		},
	},
})
```

The config is Zod-validated when comb loads it, so a typo fails at load rather than at apply, with one message that names the file and the key, whether it is exported through `defineConfig` (which only types it), as a plain object, or as a function, sync or async, that returns one; a function that returns a function is refused, naming the form below (a program that imports its config module instead calls `await parseConfig(imported)`, on either form, the one parse `loadConfig(path)` runs, since `defineConfig` checks nothing at run time): every object is strict, and a key comb does not know is refused by name. `diff`, `apply`, `check` and `status` all take a database by its name here; a database whose tables and FTS live under another name in `comb.config.ts`, as two shards of one schema do, says so with `codegen: "shard"`, and `diff shard-0` reads that database's FTS. Each `provider` is a discriminated union on `type`: `bun-sqlite` (`path`), `libsql` (`url`, `authToken?`), `turso` (`databaseName`, the Turso database's own name, `org`, `apiToken`, and `group`, default `default`), `d1` (`databaseName`, the wrangler config's `database_name` or binding; wrangler finds the database through its config), `postgres` (`url`, with `devUrl`, `schema` and `lockTimeout` defaulting to `docker://postgres/17/dev`, `public` and `5s`). There is no `neon` type: a Neon or Supabase database is a `postgres` URL. A database is one of two shapes, held at load: one target, with its `name` and `provider`, or `environments`, at least one, chosen by `-e`, each named by its key unless it gives a `name` and taking the database's `provider` unless it gives its own; a database with both a `name` and `environments`, or an environment with no provider at either level, is refused. Every environment of a database has its dialect, and `-e` on a database that declares no environments is refused. A `postgres` `url` is checked when a command resolves its environment, not at load, so a production URL unset in this shell blocks no command on `-e dev`, and `diff`, which reaches only `devUrl`, needs none. `migrationsDir` and `drizzleConfigPath` are read relative to the config file, by `diff` as by `apply`.

The function form, for a config that reads its secrets when comb loads it: the function calls `defineConfig`, so TypeScript holds the object written inline to its known keys here too, and a misspelled `local` or `migrationsDir` fails to compile. `defineConfig` takes no function:

```ts
/* comb.migrate.config.ts */
import { readFile } from "node:fs/promises"
import { defineConfig } from "@lovrozagar/comb/migrate"

export default async () =>
	defineConfig({
		databases: {
			core: {
				migrationsDir: "./atlas-migrations",
				name: "core",
				provider: {
					type: "libsql",
					url: "libsql://core.turso.io",
					authToken: (await readFile("./.secrets/core-token", "utf8")).trim(),
				},
			},
		},
	})
```

A Postgres database is a URL, with the dev database Atlas replays migrations on beside it:

```ts
/* comb.migrate.config.ts */
import { defineConfig } from "@lovrozagar/comb/migrate"

export default defineConfig({
	databases: {
		analytics: {
			name: "analytics",
			migrationsDir: "./pg-migrations",
			drizzleConfigPath: "./drizzle.pg.ts",
			provider: {
				type: "postgres",
				/* direct, not pooled, and verified: Neon's host without -pooler, Supabase's direct or session port 5432 */
				url: process.env["DATABASE_URL"] ?? "",
				devUrl: process.env["ATLAS_DEV_URL"] ?? "docker://postgres/17/dev",
				schema: "public",
				lockTimeout: "5s",
			},
		},
	},
})
```

- `url` reaches comb's Atlas runs only through their environment, never the command line, and comb checks it first: an unescaped `#`, `/`, `?` or `@` in the password is refused by field name, and every line of Atlas output comb relays is scrubbed of passwords and secret query values. `PG*` variables in your shell (`PGSSLMODE`, `PGPASSWORD`) are ignored, `~/.pgpass` and `~/.pg_service.conf` are not read, and a URL naming a libpq `service` is refused, so the config is the only connection; a URL without a user is the OS user's, as libpq reads it. A libpq key Atlas's driver would send the server as a setting is dropped from the URL Atlas gets when it only tunes the connection (`keepalives` and its `_count`, `_idle` and `_interval`, `gsslib`, `sslcompression`, and `channel_binding` or `gssencmode` other than `require`), and refused by name when it asks for what Atlas cannot do (`channel_binding=require`, `gssencmode=require`, `require_auth`, `requirepeer`, `sslcrl`, `sslcrldir`, `sslpassword`). `sslrootcert=system` verifies with `sslmode=verify-full`, which it implies, as libpq does, against the CAs Atlas's driver reads: on Linux the system's CA files (`SSL_CERT_FILE`, else the distribution's bundle, and `SSL_CERT_DIR`, else `/etc/ssl/certs`); elsewhere Node's own system store (Node 22.15 and later), or, under Bun or an older Node, the runtime's bundled CAs, which a verification failure names. A TLS file is checked only under an sslmode that reads it (`require` and the `verify-` modes, or none), and an encrypted `sslkey`, which Atlas's driver cannot read, is refused with the `openssl pkey` line that decrypts it, as is an `sslcert` without its `sslkey`, which libpq and Atlas's driver refuse. comb warns when a host off the machine (anything but `localhost`, 127.0.0.0/8 or `::1`) is reached with `sslmode=disable`, `allow` or `prefer` (a URL with none is `require`), and on a Neon `-pooler` host or Supabase's port 6543: a transaction pooler drops the session lock Atlas holds. A URL naming several hosts is refused, as comb migrates one database, and so is a `passfile` libpq would ignore (not a plain file, or readable by others) when the URL has no password.
- `devUrl` is an empty database Atlas may wipe; it must not be `url`. The default, `docker://postgres/17/dev`, needs Docker; match its major version to your server. On a `postgres://` `devUrl`, `check` and `baseline` replay the history in a database of their own on its server, made from `template0` for one run and dropped after it, so its role needs `CREATEDB`. The extensions `devUrl`'s database holds are made there first, each in its schema at its version, so the role must be able to create them too; one a replayed file creates is left to that file, so a plain `CREATE EXTENSION` checks as apply runs it. A check stopped by Ctrl-C or SIGTERM drops its database and the roles it made first, then exits as the signal would. One killed outright leaves them, and the next `check`, `baseline` or `apply` on that server drops them at once: each is named for the backend that made it, and goes once that backend is gone, so a run never touches a live run's database, nor one anybody else is connected to. A statement the killed run left running, such as a long backfill, is its own: the replay's connections carry its name as their `application_name`, and the sweep ends them before it drops the database; on Postgres 14 and later such a statement also ends by itself within a second, as the replay asks the server to check that its client is there. A superuser `devUrl` drops what any role's runs left; any other role drops only the databases it owns or is a member of the owner of, and the roles it made. `apply` sweeps only when the target's server holds something a killed run left, so a `devUrl` the deploy cannot reach costs nothing; then it waits at most 5 seconds for `devUrl` (unless the URL sets `connect_timeout`), and when that fails it says so and applies anyway. A drop that fails is left to a later run and never changes the verdict. A role the history creates is made `NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS`, in no role the replay did not make, since the replay needs only its name; check says so for each `CREATE ROLE` or `CREATE USER` that asked for more, and apply alone gives it the rest.
- `schema` is the one schema comb migrates. Both URLs are scoped to it (`search_path`; a URL that names its own `search_path` must name this schema), and Atlas keeps its history outside it: `public`'s in `atlas_schema_revisions`, any other schema's in its own `atlas_schema_revisions_<schema>`, so two schemas of one database, each migrated by its own config, never share a history. A schema name that is not plain lower case, or would pass Postgres's 63-byte limit, is named by its hash. An object the drizzle schema puts in another schema, a Supabase `auth.users` reference included, is an error. A schema other than `public` must exist on both databases, and your app's `search_path` must match.
- `lockTimeout` bounds how long a statement waits for a lock (`0` for no bound), so an `ALTER` behind a long reader fails instead of queueing every later query. comb sets no `statement_timeout`; add one to the URL's `options` if you want it.

`loadConfig()`, `resolveDatabaseConfig()`, and `createProvider()` turn that into a `ConnectionProvider`. Each provider exposes the same `Connection` interface, and the SQLite introspection reads it: `introspectSqliteSchema`, `getSqliteTables`, `getSqliteColumns`, `getSqliteIndexes`.

### Diff and apply

```bash
bunx comb migrate init
bunx comb migrate diff core add_post_slug
bunx comb migrate apply core --dir ./atlas-migrations
```

`diff` runs the project's `drizzle-kit export`, on the runtime running comb, to dump the desired schema, hands it to Atlas, and writes a timestamped SQL file.

FTS5 tables stay out of what Atlas sees, because its dev SQLite has no fts5 module. Atlas replays a copy of the history with the FTS statements stripped and diffs a target without them. comb then appends the FTS part itself: for each FTS table whose definition changed, or whose content table Atlas rewrote (SQLite drops a table's triggers with it), it drops the triggers and the virtual table, creates them from the config, and runs `INSERT INTO <fts>(<fts>) VALUES ('rebuild')`. A database the config declares must load: a broken `tables` file is an error, not a diff without FTS. Since Atlas only ever sees the copy, comb checks the real `atlas.sum` against the files first.

A migration's hash is its SQL with comments and layout normalized away, never the text inside a literal. Files recorded under the pre-0.5.0 hash, which stripped `--` even inside literals, still count as applied, on SQLite, libsql and D1 alike.

`apply <db>` takes its database from `comb.migrate.config.ts` when the project has one: `-e/--env` picks the environment, whose provider supplies the connection, and `migrationsDir` is read relative to the config file. Without a migrate config, `<db>` is a D1 binding in the working folder's wrangler config, remote by default and local with `--local`. A Postgres database goes through Atlas ([Postgres](#postgres)). On every SQLite database, apply first checks, and applies nothing unless every pending file passes:

1. The directory matches its `atlas.sum`.
2. A file is pending unless the history records it: its hash, current or pre-0.5.0, in `__drizzle_migrations`, or on D1 its name in the binding's `migrations_table` (`d1_migrations`). A pending file that sorts before an applied one is refused, since it would run after files written later.
3. Each pending file is classified against the schema the earlier files leave: `parseMigration()`, `classifyMigration()` and `extractDropStatements()` read each statement, and each action of an `ALTER TABLE`, through quoted and schema-qualified names, and rate the file:
   - **unsafe** loses data or breaks deployed code by name: dropping a table, column, schema, type, sequence or role, `CASCADE`, changing a column's type, `SET NOT NULL`, adding a `NOT NULL` column without a default, renames, `TRUNCATE`, `DELETE` or `UPDATE` without a `WHERE`, an FTS5 `'delete'` or `'delete-all'` command, a statement comb does not recognize, and every trigger, function, procedure or rule made, replaced, altered or dropped, and every `DO` block, which comb names by that rule ("comb rates every trigger change unsafe") whatever else it reads of them, and on SQLite every pragma comb does not write itself (all but `foreign_keys` and `defer_foreign_keys`), named the same way. An unsafe file runs only after a yes on a terminal, or when the file approves itself with a line of its own, `-- comb:allow-unsafe: <reason>`, which goes through review with the file. `--yes` does not cover it, so a pipeline that always passes `--yes` cannot drop data unreviewed.
   - **cautious** drops nothing a row holds: indexes, constraints, defaults, views, a grant, a new owner (who bypasses row level security), a sequence reset by `setval`, rows loaded by `COPY`, an `EXECUTE` of a statement comb cannot read. It runs with `--yes` or a yes on a terminal.

   What a statement writes is read from the engine, never from its spelling. On SQLite the proof run reads it (below). On Postgres comb reads every statement with Postgres's own parser (libpg-query 17) and walks every node, so a write in a CTE, a subquery, a rule's action or behind `EXPLAIN ANALYZE` counts, and so does `UPDATE users*`, `U&"users"` or `"users"SET`:
   - a `DELETE`, a `MERGE` that updates or deletes, and an `UPDATE` or upsert of rows that were there before the file are unsafe; an `UPDATE` or upsert that only fills a table the file created, or only columns it added (once), is cautious;
   - a write to a table whose trigger the history holds fires it, and is unsafe;
   - a `TEMP` table or view, or one in `pg_temp`, that takes an existing table's name shadows it for the rest of the file, and is unsafe;
   - a `DO` block, a `CREATE FUNCTION`, `PROCEDURE` or `TRIGGER`, a `CALL`, and a call of any function that is not a pure built-in (`lower`, `now`, `gen_random_uuid`, `jsonb_build_object` and the like) run code comb does not read, and are unsafe; `setval` is cautious, as is `nextval`, whose advance a rollback does not undo; `current_setting`, which copies a setting into what it writes, and `dblink` are unsafe;
   - a statement Postgres cannot parse is unsafe.
   - **safe** runs without asking.

   Without a terminal or an approval, `apply` stops before running the file. A SQLite table rebuild (Atlas copies the rows into `new_t`, drops `t` and renames `new_t`) is cautious when it copies every column the earlier files gave `t`, and unsafe when it leaves one out, which is how Atlas drops a SQLite column. A rebuild of a table other tables reference is unsafe unless it carries comb's guard exactly as `comb migrate diff` wrote it (see below); an edit inside the guard makes it unsafe again.

   On bun:sqlite, libsql and D1, `check` and `apply` also run a proof first. Each pending file runs on a private copy of the database's live schema, on the SQLite its files apply on (the runtime's for bun:sqlite, libsql's own for a libsql or Turso database, so a vector index is proven and syntax libsql's older SQLite refuses is refused at check), seeded with six rows per table chosen so a change shows, one statement at a time, each file on a fresh connection, as it applies. comb splits a SQLite file where SQLite ends a statement (its `sqlite3_complete()` rule): at a `;` in code, except inside a trigger's body, which ends at `END` and `;`, so a column or table named `begin` or `end` is a name wherever it stands. The copy's own SQLite then confirms each piece is one statement, and a piece it reads as more is refused, naming the file and the statement, since libsql's client runs only the first statement of a string. On bun:sqlite and D1 the copy is a file in a temporary directory only you can open, removed after the run; one a killed run left is removed by a later run. On libsql and Turso it is held in memory, so no file is left. Before each statement runs, SQLite itself (`EXPLAIN`) says what it writes to the tables that were there before the file. An update of a column they had, a delete of their rows (a `REPLACE` that meets one included), a trigger on them it can fire (its `WHEN` is not evaluated), an update, delete or replace of a virtual table's rows, and a temp table or view that takes one's name make the file unsafe, whatever rows the statement meets and however it is spelled. A backfill of only the columns the file added is cautious, and a write to a table the file created is safe. Then every table that was there before is compared, row for row, on the columns it had. A lost row, a lost column, or a value changed, copied between columns or moved between rows makes the file unsafe, and the reason names the table and column. The one allowance: a NULL that becomes the new default of a column the file made NOT NULL is cautious. A file the copy cannot run is unsafe, with the statement and why, and so is every pending file after it, which nothing then proves. A table comb cannot seed is listed as unproven, with why. On Postgres, writes are rated from their text, and `check` lets Postgres decide what no database runs: on a `postgres://` `devUrl` it replays the history and the pending files there before any approval, as Atlas applies them: each file in a transaction of its own, a `-- atlas:txmode none` file statement by statement, each in a transaction of its own first, so the counts below refuse a change past its database before it commits, and bare, as Atlas sends it, where Postgres runs it only so, in a database of its own (see `devUrl` above). So a batched backfill that commits inside a `DO` block or a procedure passes, and a `LOCK TABLE`, `SAVEPOINT`, `RELEASE`, `ROLLBACK TO` or a cursor not held, outside the file's own `BEGIN`, stops `check` as it stops `apply`, named with Postgres's message while comb rates the file, so on any devUrl. A statement the dev database refuses stops it, naming the file, the statement and Postgres's message (a retype of a column a view, a rule, a policy, a trigger's `WHEN`, a generated column or a `BEGIN ATOMIC` function reads). A statement whose scope is the server or another database is left out, and `check` names it: `ALTER SYSTEM`, `CREATE`, `ALTER` and `DROP DATABASE`, `ALTER` and `DROP ROLE`, a grant or revoke of a role the replay did not make, a tablespace, a subscription, `CHECKPOINT`, `DROP` and `REASSIGN OWNED`, `REINDEX DATABASE` or `SYSTEM`, a prepared transaction, a `COPY` to a server file or from a program, and an owner, comment, grant, rename or security label of a database, a role, a tablespace or a server parameter. So is a statement that runs a function acting on the server, named as a call of it: a replication slot's making, dropping or reading of changes, `pg_terminate_backend` and `pg_cancel_backend`, `pg_reload_conf`, `pg_switch_wal`, a statistics reset, `lo_export`, a replication origin's work, and every `dblink` function, whatever schema holds them, as a connection left out leaves its cursors and queries nothing to reach; a hidden call whose effect leaves no state comb can read, such as an ended session or a written file, runs on devUrl's server; a definition that only names one (a view, a function, a trigger, a policy, `EXPLAIN` without `ANALYZE`) runs as written. A replication slot a `DO` block or a function makes is read from the server after the file, refused when the file names it, and dropped. A change a `DO` block or a function makes to the database it runs in, named by `current_database()` (a setting, a grant on it, its comment), is the replay's own, since the replay drops that database after it; making it a template or giving it another owner stays refused, as the replay could not drop it then. A `CREATE ROLE` runs, since a policy may need its role: a role the server already has is used as it is, and one the replay made is dropped after it. A grant or revoke of roles the replay made runs too, such as the `GRANT app TO CURRENT_USER` a role that is no superuser needs before `ALTER TABLE … OWNER TO app`, since dropping the role undoes it. A pending file that makes a role the target's server already holds, by `CREATE ROLE` or a rename to it, stops `check` as it would stop `apply`, with `role "<name>" already exists; apply would stop at <file>`: another database's apply on the same server may have made it. `check` reads the target's roles for this on a `docker://` `devUrl` too. A `DO` block, a function, `EXECUTE` and `CALL` run as written, and Postgres says whether one changed the server, twice. In a file that runs in a transaction, Postgres's own counts of the transaction's writes decide before its `COMMIT`: a file that changed a role, a membership, a database, a setting, a comment, a tablespace or anything else the server's databases share, past what the replay drops after it, is rolled back and refused, naming the file and the change. A role such a statement adds is the replay's to drop, as one its own `CREATE ROLE` made: the replay adopts it, makes it `NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS` with no password before the file commits, and drops it after, and `check` says so for each, so the usual `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') THEN CREATE ROLE app; END IF; END $$` passes. A change to a role the replay made or adopted is its own too: the role's options and password, a membership in it or of it, its settings and its comment or security label. A change to any other role stays refused. On a superuser's devUrl comb reads `pg_authid`, so a password change is named as one (`role app changed (rolpassword)`) and the password itself is never read out; on any other devUrl a change its role cannot read, such as a role's password, is refused as one. A devUrl whose server keeps no counts for its role (`track_counts` off) is refused, naming the setting, and so is a file that turns them off. Around every file and every statement a `-- atlas:txmode none` file sends bare, comb also reads the server's shared catalogs as committed, another replay's own rows left out. That sees what a bare statement changed, which no transaction counts, and what a second connection committed, such as `dblink_exec`'s `CREATE DATABASE` or `CREATE ROLE`, which the replay's own counts never see. A `txmode none` statement runs bare only where a block changes what it does: one Postgres refuses in a block (an outside-only statement such as `CREATE INDEX CONCURRENTLY` or `VACUUM`, or a `DO` block or procedure that commits), one Postgres runs only in a block (a `LOCK`, a `SAVEPOINT`, `RELEASE` or `ROLLBACK TO`, a cursor not held), and the file's own `BEGIN` and `COMMIT` and what runs between them. A change one of these makes past its database has committed by the time the read sees it, so `check` refuses it and names what devUrl's server keeps, which comb cannot undo. These are the server's catalogs, not the replay's, so a change there is the file's only when the role, database or other object it is to is one the file names: unquoted (folded to lower case, as Postgres folds it), quoted, or inside a string a `DO` body, `dblink_exec` or `format()` may run. Such a change is refused, naming the file, the statement and the change; a role it added is dropped, and so is a database it added that no session is in. A change to any other object is another session's, and `check` passes it. A name the file builds at run time, by concatenation, from a query, or in a function another file defines, is not one it names, so `check` neither refuses nor drops that change. A role's password reads only from `pg_authid`, so a password a bare statement changes is seen only on a superuser's devUrl. This needs the `postgres` package; on a `docker://` `devUrl`, which comb cannot reach, or without `postgres`, `check` says it did not replay and rates the files alone. The target is only read, and a file that changes the server is refused before anything reaches it.

4. On SQLite, libsql and Turso, comb applies each file's statements, as written, and the insert of its hash as one batch, which every provider runs all-or-nothing. On a SQLite file (bun:sqlite, a libsql `file:` URL), each file applies on a connection opened for it and closed after it, as wrangler runs each file on D1, so a pragma a file sets on its connection (`ignore_check_constraints`, `recursive_triggers`, `legacy_alter_table`, `case_sensitive_like` and the like) ends with the file, and the next file runs as it would alone. A libsql server, which a libsql URL of any other scheme (`http`, `https`, `ws`, `wss`, `libsql`) reaches and which Turso runs, refuses those pragmas: it parses each statement first and runs only what it lists. So check holds a file for such a target to what the libsql server (sqld) runs, measured on the sqld comb's tests pin, and refuses the rest with no override, naming the server: a pragma outside its list or with a quoted name (it runs `foreign_keys`, `defer_foreign_keys`, `user_version`, the `table_info` family and the checks, and reads most others), `ANALYZE`, `ATTACH`, a `TEMP` object and `load_extension()`. Turso cloud is held to the same set. With no connection setting left to end, a server's files apply through the one client the run writes with, and a Turso apply mints one token for it. An in-memory database (`:memory:`) lives in its one connection, so every file applies through that one. A pragma whose setting is the process's (`hard_heap_limit`, `soft_heap_limit`, `temp_store_directory`) reaches every connection and outlives the file, so check refuses it, with no override. Every SQLite provider applies with foreign keys on, as the proof runs: bun:sqlite, which SQLite opens with them off, turns them on for each connection comb opens. A file is applied and recorded, or neither. A transient failure retries the whole batch through `withRetry()`, which reads it from the error's structured fields alone (on the error or a cause): an HTTP status of 429 or 5xx, or a network code such as `ECONNRESET` or `UND_ERR_SOCKET`. An error with a `SQLITE_` code is never retried, whatever its message says. On a SQLite file, a write lock that the app serving the file or a second runner holds is waited for rather than failed on: every connection comb opens to the file sets `PRAGMA busy_timeout = 5000`, SQLite's own wait, which retries no failed statement, and each file's batch begins `IMMEDIATE`, taking the lock before any statement. Its record is written first, so a file another run applied while this one waited fails on its name before it runs anything, and is skipped as `Skip (applied by another run)`. `--file` applies one file on its own, which no sum or order covers.

On D1, wrangler applies. comb reads the binding from the wrangler config with wrangler's own reader, refuses when its `migrations_dir` is not comb's `migrationsDir` or its `migrations_pattern` takes anything but that directory's `.sql` files, orders the files as wrangler does (by leading number, then name, so 8- and 14-digit prefixes mix), checks exactly the files wrangler will apply, and runs `wrangler d1 migrations apply` with stdin closed. wrangler runs each file and its `d1_migrations` row as one batch locally and one query remotely, and takes no backup, so bookmark a production database (Time Travel) before an apply. comb then reads the table back and fails unless it holds exactly the files it checked, printing wrangler's own words; a declined prompt or a failed file leaves its row out. A file that landed in the directory while wrangler ran, which wrangler applied and comb never checked, is named, and listed under `applied` in `--json`: check it against git, then run `comb migrate baseline <db> --hashes`. `--file` does not apply to D1. D1's own engine refuses much a SQLite build runs: pragmas outside [Cloudflare's list](https://developers.cloudflare.com/d1/sql-api/sql-statements/), functions outside workerd's allowlist, modules but fts5, fts5vocab and rtree, TEMP objects, savepoints, `_cf_` names, and its limits. So check runs each pending file on D1's own engine: after the proof, on a scratch local D1 that the checked wrangler's Miniflare opens with the live schema and the proof's rows, each file as wrangler sends it (its `splitSqlQuery`, with the `d1_migrations` row it appends), then compiles each view, and each table's writes, that the file made or changed, since D1 resolves a function in a trigger, a view or a generated column only when a statement uses it. A file D1 refuses there is refused, naming D1's error, and no approval overrides it. wrangler `--local` deletes the first `BEGIN TRANSACTION;` and `COMMIT;` of a file holding `BEGIN TRANSACTION`, inside literals and comments too, where a remote apply sends the text as written, so check refuses such a file; split the words, as in `'BEGIN ' || 'TRANSACTION'`. A database comb 0.7 migrated records its files in `__drizzle_migrations`; apply refuses it until `comb migrate baseline <db>` copies that record into `d1_migrations` once. wrangler's table records names only, so comb records each applied file's hash beside it and refuses a file applied, then edited. A name is in wrangler's table only once comb holds its hash or its intent. Apply records each pending file's hash as an intent before wrangler runs, and moves it into comb's hashes once wrangler's table names the file, so a recorded hash is always the text wrangler ran: an apply that fails or is lost leaves only intents, which the next apply clears, and a file wrangler applied while comb lost the move counts as hashed while its text still matches its intent, until the next apply or `--hashes` records it. Baseline writes the hashes before wrangler's rows, so a call lost between them leaves nothing a rerun cannot finish. A rerun of baseline copies every file `__drizzle_migrations` records that lacks either row, so it also finishes a baseline a lost call left half done. A file applied before comb recorded hashes has none, and `status` names it; once you have checked those files against git, `comb migrate baseline <db> --hashes` records the current hash of each applied file that has none, after the same checks apply runs (it refuses while a name in the history matches no file, or a recorded hash is not its file's). Run it once; `--hashes` is for D1 alone, as every other history records each hash as it applies. A D1 database's history is in four tables, which a tool that empties a database must keep, rows and all: `d1HistoryTables(migrationsTable?)` from `@lovrozagar/comb/migrate` names them, the binding's `migrations_table` first (`D1_MIGRATIONS_TABLE`, `d1_migrations`, by default), then `D1_HASH_TABLE` (`_comb_migration_hashes`), whose loss lets an edited applied file pass `check`, `_comb_migration_hash_intents`, the intents of an apply in flight, and `DRIZZLE_HISTORY_TABLE` (`__drizzle_migrations`, comb's history before 0.8).

`baseline <db>` records the files as applied without running them, for a database whose schema was set up out of band, after Atlas compares the database's schema with the one the history leaves; any difference is printed and nothing is recorded. On SQLite comb reads the schema from the database itself and compares FTS5 tables by name, since Atlas's dev SQLite has no fts5 module. On D1 it copies only what `__drizzle_migrations` records.

The circuit breaker (`createCircuitBreaker()` and its checks) is a library API for your own runners, such as a multi-tenant fan-out; the CLI does not use it, because one atomic batch per file already leaves nothing half-applied.

### Postgres

`diff` exports the drizzle schema with the database's `drizzleConfigPath` and hands Atlas the rest, on the dev database, scoped to `schema`. Atlas OSS refuses views, materialized views, policies, sequences, roles and extensions, so comb keeps them out of what Atlas replays and diffs and writes their part of the migration itself, around Atlas's statements:

- first, new extensions (`CREATE EXTENSION IF NOT EXISTS`), roles and sequences, since a table may use them, and a changed sequence `ALTER SEQUENCE`d in place, never dropped (that would restart it);
- then the drops of every changed or removed view and policy, and of each one over a table Atlas alters, since Postgres refuses to retype a column a view or policy reads; a view over a dropped view goes first;
- after Atlas's statements, those views and policies created again from the schema, and removed sequences dropped.

Roles and extensions are never dropped: they outlive one schema. Before Atlas replays the history, comb creates on the dev database every sequence and extension the history or the target holds (`CREATE … IF NOT EXISTS`), so a default calling `nextval` and a column of an extension's type (`citext`, `vector`, PostGIS) load there. An extension enters the history through a migration of your own with `CREATE EXTENSION IF NOT EXISTS …`, and the dev server must be able to install it (the stock `docker://postgres` image has `citext`, not `vector`). On a persistent `devUrl`, these sequences and extensions stay after the run; Atlas wipes only the schema it diffs.

An enum value Atlas adds goes into a file of its own a version earlier, since Postgres refuses to use a value added in the same transaction (55P04). Atlas cannot drop an enum value; comb says how to write that migration by hand. A statement Postgres runs only outside a transaction needs its own file whose header holds `-- atlas:txmode none`. Atlas reads a file's header as the comment lines it starts with, other comments and `-- comb:allow-unsafe:` among them, closed by a blank line (spaces or CRLF allowed); without that blank line it reads no directive and runs the file in one transaction, where the statement fails. comb reads the header by the same rule, held to the pinned Atlas. On every dialect, `check` and `apply` refuse a file whose opening comments hold an `atlas:` line with no blank line after them, naming the file and the line: add the blank line, or remove the line. A first-line `-- atlas:delimiter` is the one exception, as Atlas reads it where it stands. comb also refuses at check a header whose txmode Atlas refuses, quoting Atlas: a value other than `none` or `file` (`NONE` among them), `all`, or two txmode lines. `check` reads which from the parse tree and refuses one anywhere else, naming it: every `CONCURRENTLY` index build, drop or reindex and partition detach, `VACUUM` (not `ANALYZE` alone), a bare `CLUSTER`, `REINDEX SCHEMA`, `DATABASE` or `SYSTEM`, `ALTER SYSTEM`, `CREATE` and `DROP DATABASE`, `ALTER DATABASE … SET TABLESPACE`, `CREATE` and `DROP TABLESPACE`, `DISCARD ALL`, `COMMIT` and `ROLLBACK PREPARED`, `CREATE SUBSCRIPTION` that makes a slot (its default), `DROP SUBSCRIPTION`, `ALTER SUBSCRIPTION … REFRESH` or a publication change that refreshes, and `ALTER SUBSCRIPTION … SET (failover)`. A file Atlas runs in one transaction holds no `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`, `ABORT` or `PREPARE TRANSACTION` of its own: its `COMMIT` would end Atlas's transaction, so what ran before a later failure would stay while the file is reported rolled back. `check` and `apply` refuse one from the file alone, before `check` replays anything, with no `-- comb:allow-unsafe:` override; a `-- atlas:txmode none` file keeps its own, and a `SAVEPOINT` nests in Atlas's transaction. Every file comb writes keeps Atlas's directives first that way.

`apply` works on a private copy of the migrations directory, checked against `atlas.sum`, so what Atlas runs is exactly what comb read. It asks Atlas for its status and stops at any error, and at a file older than the latest applied one, which Atlas would skip without a word; a file Atlas ran halfway outside a transaction resumes only if unchanged, since Atlas resumes it by statement count. A dry run comes next, so a database that has objects but no history is told to `baseline` before anyone is asked. Each pending file is then classified and approved as on SQLite (unsafe: a yes on a terminal or `-- comb:allow-unsafe: <reason>`; cautious: `--yes` too), with lock warnings for statements that block a table: a non-concurrent index on an existing table, an added column whose default calls a function not known to be `IMMUTABLE` or `STABLE` (a listed built-in such as `now()`, or a history function whose every overload says so), a scanning constraint without `NOT VALID`, a retype that does more than widen (a longer or unbounded `varchar`, or `text`; more `numeric` precision at the same scale; a longer `varbit`, each without `USING`, is done in place, safe and unwarned), `ATTACH PARTITION`, a `REFRESH MATERIALIZED VIEW` that is not concurrent, and a `LOCK` in `SHARE` mode or stronger. Atlas then applies each file in its own transaction and records it; a failed file is named with its statement, and the files before it stay applied. Atlas holds a lock while it applies, so two applies never run at once. `--file` and `--local` do not apply to Postgres.

`baseline <db>` records every file up to the directory's latest as applied without running any, and refuses a database that already records migrations, and one whose tables are not the ones the history leaves on the dev database. Atlas OSS leaves out functions, procedures, triggers, views, materialized views, sequences, policies, domains, composite and range types, collations, rules, row level security, extensions, aggregates, `SECURITY DEFINER`, operators, casts, views' options (`security_invoker`, `security_barrier`, `check_option`), materialized views' indexes, a table's replica identity, event triggers and publications, and finds a database that differs only there in sync, so baseline compares them itself, through `postgres` (an optional peer, which baseline refuses without): it replays the history on the dev database's server as `check` does, comb's objects and all, file by file in a database of its own, leaving out what reaches past it, and reads the target schema's catalog there and on the target with one query, so Postgres itself decides what a cascade, a rename or a move leaves. A statement the dev database refuses stops it too, naming the file, the statement and the error. The role the dev URL connects as stands for the target's, so a policy `TO CURRENT_USER` compares as each database was built. This needs a dev database comb can connect to: a `docker://` devUrl is Atlas's own container, so comb baselines through Atlas alone only a history whose every statement is one it has proved makes none of these objects (a table, an index, a column or constraint change, an enum, a schema, data, a session setting, a comment, a grant, a rename, a drop), and refuses any other naming devUrl, whatever it makes. Each is compared by name, and some by their settings too: a trigger by when it fires, a policy by its command, roles and kind (permissive or restrictive), a sequence by its start, increment, bounds and cycle, a table's row level security by whether it is enabled and forced. One the database or the history lacks refuses the baseline, extensions' own objects aside (and a range type's constructors, which are the type's), as is a sequence a column owns (a serial's, an identity's, or one `OWNED BY` a column), which is its table's; a partition's copy of its parent's trigger is Postgres's own. An extension, an event trigger or a publication refuses only when the database lacks one the history creates, since a platform installs its own. Not compared, which baseline names on every run: views' and policies' queries and checks, triggers' `WHEN` clauses, view columns' defaults, columns' statistics targets, statistics objects, text search configurations and dictionaries, foreign data wrappers, servers and user mappings, grants and comments. Whatever Atlas says on stderr as a `diff` or a `baseline` compare succeeds, comb prints as `Warning: Atlas: …`, as Atlas OSS may say there that it left part of a schema out. `status <db>` lists applied and pending files and warns of an applied file edited since, which Atlas never runs again. Atlas prints every statement it runs, so keep secrets out of data migrations; take a snapshot (a PITR point, a Neon branch) before an unsafe apply, and prefer expand-and-contract to renames and drops in one deploy.

### SQLite transforms

Atlas wraps SQLite table rebuilds in `PRAGMA foreign_keys = off;` … `PRAGMA foreign_keys = on;`. That pragma is a no-op inside a transaction, which is exactly where D1 runs it — so the rebuild proceeds with FK enforcement still live and fails. `applySqliteMigrationTransforms()` rewrites the pair into a single `PRAGMA defer_foreign_keys = on;` prelude, which defers the checks to commit time. It is idempotent and leaves every `CREATE`, `ALTER`, and `INDEX` statement byte-identical.

The pragma defers checks, never `ON DELETE` actions. With foreign keys on (always on D1, and by default in `@libsql/client`), Atlas's `DROP TABLE t` first deletes every row of `t`: `CASCADE` and `SET NULL` change the tables that reference it, `RESTRICT` fails, and `NO ACTION` fails at commit, since the rows return under the renamed copy. So `comb migrate diff` guards each rebuild of a referenced table. Between Atlas's copy and its drop it saves every table with a foreign-key path to `t` (Atlas's `new_t` too when it references `t`) into a `_comb_keep_<table>` table, saves `t`'s `sqlite_sequence` value, and empties those tables, each after the tables that reference it. After the rename it refills them in the opposite order, restores the sequence, and drops the keep tables. Rowids survive every rebuild, the rebuilt table's included: a table keyed by an `INTEGER PRIMARY KEY` keeps them with its key, and any other rowid table carries them apart, in its keep table or, for `t` itself, in Atlas's copy, which comb writes as `INSERT INTO new_t (rowid, …) SELECT rowid, …`. D1 caps a `SELECT` at 100 result columns, so a table with 100 stored columns and no `INTEGER PRIMARY KEY` keeps its rows whole under new rowids, and the classification names it (`t gets new rowids (100 columns, no INTEGER PRIMARY KEY)`). The guard doubles the writes to those tables, which counts against D1's 30-second limit per query on a large table; a 1M-row closure takes under a second on local SQLite. The diff refuses, naming the object, when a table it would empty has a trigger other than an FTS one (the trigger would fire on both the emptying and the refill), when a table already uses the `_comb_keep_` prefix, or when the history does not show a reached table's columns. Before such a file applies, `check` and `apply` also read the database's own foreign keys and triggers, and refuse when a table no migration made references the rebuilt table (its rows would go with the drop) or a trigger no migration made sits on a table the guard empties.

<!-- ts-context
declare const atlasSql: string
-->

```ts
import { applySqliteMigrationTransforms } from "@lovrozagar/comb/migrate"

const safe = applySqliteMigrationTransforms(atlasSql)
```

## Query layer

`@lovrozagar/comb/query` is dialect-agnostic: it parses and validates, and produces an AST. `@lovrozagar/comb/query/sqlite` lowers that AST to SQL.

### Filter grammar

PostgREST-style, parsed by `parseFilter()`:

```text
field.op.value          single condition
a.eq.1,b.gt.2           AND at top level
or(a.eq.1,b.eq.2)       OR group
and(...)                nested AND group
status.in.(draft,sent)  list values
@computed.eq.1          computed field (resolved by your resolver)
```

Operators: `eq`, `ne`/`neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`, `ilike`, `is`. `contains`, membership in a JSON array, is no declared type's default: a field spec lists it (see below), and `filterToSQL` runs it on SQLite. `is` takes `null` and `notnull` (any case) on every field, and `true` and `false` on a `boolean` one.

A value that holds `,`, `(`, `)` or `.` is written in double quotes, PostgREST style: `title.eq."Hello, world"`, `title.in.("a,b",c)`; inside quotes `\"` and `\\` escape. Whitespace around a bare value is trimmed.

`like` is case-sensitive and `ilike` ignores ASCII case. In both, `*` is the wildcard and every other character is literal: `like` lowers to SQLite `GLOB` (with `?` and `[` made literal), `ilike` to `LIKE … ESCAPE` (with `%` and `_` escaped). SQLite folds only ASCII case, so `ilike` does not match `Ž` against `ž`; search a pre-normalized column with `q` for that. An empty `in.()` matches nothing and an empty `nin.()` matches everything — neither widens to the whole table.

`validateFilter()` parses and checks in one step, against declared field types, and rejects operators a type does not support — `string` allows `like`, `boolean` allows only `eq`, `ne`, and `is`, and so on — and values that are not of the field's type: a `number` takes a decimal number, a `date` epoch milliseconds, a `boolean` `true` or `false`. A valid result carries each value typed as its field declares. Unknown fields are rejected rather than silently dropped, so a typo returns a 400 instead of the whole table. Unbalanced parentheses, an unclosed `in.(` list and trailing input are syntax errors. Each expression is bounded by `FILTER_LIMITS` — 20 conditions, 3 nested groups, 50 `in`/`nin` values per list, 60 bound values in all, and 50 bytes in a `like` or `ilike` pattern (`maxPatternBytes`: a value with a `*` inside it, measured as SQLite reads it, escaped, so a `[` in a `like` counts as the three bytes of `[[]`) — overridable per call with a third `limits` argument, where a key left out or set to `undefined` keeps its default and any value but a whole number from 0 throws a `TypeError` naming it, as `createListQuerySchema`'s `limits` do. D1 refuses a longer pattern only once it reads a row, so the 400 would depend on the data; the cap refuses it before the query runs. The defaults keep every request the list schema accepts within D1's 100 bound parameters per statement: 60 filter values, 8 search words (`maxSearchTerms`, one `LIKE` each), 10 for a three-key cursor and 2 for limit and offset make 80, which leaves 20 for your `baseWhere`. Raise a limit only on a database without that cap, or with a `baseWhere` that binds less. `createListQuerySchema` also caps the `filter` string at 2048 characters before parsing it (`limits.maxFilterLength`), as it caps `q` at 200, `select` at 500 and `order` at 200. A URL limit counts bytes once percent-encoded (Cloudflare's is 16 KB), and one CJK character is nine of them, so `filter` is also capped at 4608 bytes, `q` at 600, `order` at 200 and `select` at 500 (`REQUEST_BYTES`), each measured as the widest common encoding writes it: a space (`%20` in a URL) and a mark such as `~` or `!` (`%7E`, `%21` in a form) count as 3. With the cursor's 8192, the largest accepted query string is at most 14 KB however a client encodes it, `maxQueryBytes`: 16 KB less 2 KB for the path and the handler's own params. A value holding a lone surrogate, which no URL can carry, is refused. The schema takes any cursor string and `readCursor` answers every one it cannot use, a longer one included, with `invalid_cursor`, so a client restarts on one key; `paginate` carries a sort value too long for the cap by reference (see [Pagination and cursors](#pagination-and-cursors)). `in` and `nin` take a list: `id.in.5` is a 400, not a driver error.

```ts
import { CombError } from "@lovrozagar/comb"
import { validateFilter } from "@lovrozagar/comb/query"

const result = validateFilter("status.eq.published,or(minute_read.lt.5,title.like.intro)", {
	minute_read: "number",
	status: "enum",
	title: "string",
})

/* null when the filter string is empty */
if (result && !result.valid) {
	throw new CombError({ cause: result.errors.join("; "), errorKey: "invalid_filter", status: "bad_request" })
}
const ast = result?.ast
```

A runtime field map, such as one built from a user table's columns, can give a field a spec in place of its type: `{ type, operators?, format? }`. `operators` replaces the type's defaults (`OPERATORS_BY_TYPE`) and may add `contains` on any type, its value typed as one scalar of the type, for an array or multi-select column: `filterToSQL` lowers it on SQLite as a member of the JSON array the column holds (`json_each`). It may also add `gt`, `gte`, `lt` and `lte` on a `string`, which compare text, so stored values must share one form: an ISO instant written in two offsets, `2024-01-01T01:00+01:00` and `2024-01-01T00:00Z`, is one instant that sorts as two. `format: "iso"` on a `date` takes ISO 8601 text, a date (`2024-02-29`) or a date-time with `Z` or an offset (`2024-01-01T00:00+14:00`), naming a real day and time by the proleptic Gregorian calendar (so `0000-02-29` is a day), in place of epoch milliseconds, and types it as the instant it names in `toISOString()`'s form: a bare date is midnight UTC, and a fraction past milliseconds is cut. A text column that stores `toISOString()` text so compares every spelling of one instant as one, `2024-01-01T01:00+01:00` as `2024-01-01T00:00Z`; on a date or number column `filterToSQL` binds it as the column stores it, epoch milliseconds or a drizzle date in either unit. A spec that lists an operator its type cannot type (`like` on a `number`, `in` on a `boolean`) or puts `format` on no date throws a `TypeError` naming the field, the operator and the type. `parseFilterNumber(raw)` is the number rule on its own: `{ value }`, or `{ error }` for a spelling `Number()` takes and comb does not (`0x4d2`, `0b1`, `0o7`, `1e999`) an integer past ±(2^53 − 1), which a double would bind as its neighbour, or nonzero digits that read as 0 or a subnormal (`1e-400`, `5e-324`), which would match the rows holding 0.

```ts
import { validateFilter } from "@lovrozagar/comb/query"

const rows = validateFilter("tags.contains.red,due.gte.2024-02-29", {
	due: { format: "iso", type: "date" },
	tags: { operators: ["contains", "is"], type: "string" },
})
```

`parseFilter()` is the parse-only half, returning a `FilterAST` (or `null`) without validating field names.

### Sorting

`parseOrder()` accepts `field.asc`, `field.desc`, and null placement (`field.desc.nullslast`), producing `SortField[]`, or `null` when an entry is empty, names no field (`asc`, `.desc`, a trailing comma) or has whitespace around it (`title.asc, created_at.desc`), or a field is named twice, as `parseFilter()` refuses a filter; the list query schema answers such an entry, or a field named twice, with an issue on `order` naming it, as the published `order` pattern refuses it. Computed sorts use the same `@` prefix and are resolved through a `ComputedSortResolver`.

Null placement follows PostgreSQL: nulls sort last ascending and first descending, and an explicit `.nullsfirst` / `.nullslast` always wins. Every SQL builder emits the placement explicitly, so SQLite's opposite default never leaks through. `createListQuerySchema` caps one `order` at 3 keys (`limits.maxSortKeys`).

### Sparse fieldsets

`parseSelect()` implements PostgREST `select`, including relation selection:

```text
select=id,title,author(display_name)
```

`createListQuerySchema({ fields })` is what puts `select` on the wire and `selectable` on `x-comb`. A relation's selectable fields are its declared `relationFields`; a relation nested inside one is not selectable, and `select=author(posts(id))` is a 400. Without `fields`, the param is omitted. The query stays fat (sort / id / `_total` / merge keys); the response gets thin. `queryHelpers.paginate` and `queryHelpers.project` honor `parsedFields` as the last mutation of item shape. Do not apply `select=` in the HTTP framework.

`filterBySelect()` cuts a row down to the parsed selection, for call sites outside `queryHelpers.paginate`; `queryHelpers.project` is the one-row wrapper.

`queryHelpers.filterValue(filterAst, field, operator?)` reads the value a filter holds every row's `field` to, and `filterValues(filterAst, fields, operator?)` reads several, so an app can resolve or authorize "the project this list is for" from `project_id.eq.p1`. A value is read only from a condition under the operator asked for (`eq` by default; `ne` and `neq` are one), at the top level of the filter's AND, and the only one there on its field: `project_id.ne.p1`, `project_id.in.(p1,p2)` under `eq`, `or(project_id.eq.p1,project_id.eq.p2)` and `project_id.eq.p1,project_id.eq.p2` read as `undefined`, since the SQL serves rows that value does not name.

### Pagination and cursors

Two modes share one input shape. Offset pagination takes `page` and `limit`; cursor pagination takes `cursor` and `limit`. Responses carry `PaginationMeta`.

A cursor holds the value of **every** sort key, the tiebreak id and the signature of the sort it was minted under (`sortSignature()`), as UTF-8 JSON sealed with XChaCha20-Poly1305: one URL-safe base64 string of a version byte, a random 24-byte nonce, the ciphertext and its tag. A client can read none of the values it carries, a column the endpoint never selects included, and it cannot write one: either would let it learn, request by request, the value of a column it can sort by but not select. `createCursor(row, parsedSort, { cursorScope, cursorSecret })` mints one as `queryHelpers.paginate` does, a long value carried by reference (below) so the cursor stays within the cap `readCursor` holds. The keyset predicate compares all keys lexicographically, each with its own direction and null placement, so a multi-key or nullable order pages without skipping or repeating rows.

Two values seal a cursor. The secret is the app's, at least `MIN_CURSOR_SECRET_BYTES` (32) bytes of UTF-8, and the key is derived from it with HKDF-SHA256. Give every worker the same `CURSOR_SECRET` through its env. The scope names the list: its route and tenant, such as `` `members:${orgId}` ``. It is bound to the seal, so a cursor minted in one list, or for one tenant, opens in no other; without it, a client could mint a cursor where it can write the sort column and replay it where it cannot read that column. Pass both to the builder, `buildListQuery({ cursorScope, cursorSecret, … })`, `buildDerivedListQuery({ cursorScope, cursorSecret, … })`, or `queryHelpers.listOptions(query, { cursorScope, cursorSecret })`, which opens the request's cursor; the query it builds seals the next one, as `queryHelpers.paginate(rows, built)` reads it. A built query holds the secret only in the functions its `pagination` seals and opens with, never as a value, so logging, inspecting or serializing one shows no part of it. `readCursor(cursor, parsedSort, { cursorScope, cursorSecret })` opens a cursor outside a builder. Both are required: a shorter secret or an empty scope is a 500 (`cursor_not_wired`) on the first page. Every builder selects the value its order breaks ties on as `_combId`, among its `extras`, and `paginate` mints the next cursor's id from it, so a row's own id, a joined child's beside the parent a derived list orders by, never stands in for it. `createCursor(row, sort, { cursorScope, cursorSecret, idField: "_id" })` mints one by hand from the field a row keys its tiebreak under.

A cursor sealed under another secret or scope, a tampered one, one spelled another way for the same bytes, one minted under another order, and one that does not decode are all `invalid_cursor`, a 400, so rotating the secret ends the lists in flight with a 400. The list schema takes no secret, since schema modules load where no env exists (a gateway's route codegen): it takes the cursor as a string, and only the opening calls read it, so a malformed cursor is `invalid_cursor` as a tampered one is.

A sort value too long for the cap, such as a title a client wrote, goes by reference: the cursor carries the row's id, the longest prefix of the value that fits and the value's length, both in code points, and the keyset reads the value from the row while the row still has that prefix and length. That is exact while the row is there unchanged; an edit that keeps both the prefix and the length still moves the bound to the new value. Once the row is deleted, or edited otherwise, the list resumes from the prefix (followed by U+10FFFF when descending), as a plain cursor resumes where its value stood: it may serve again rows whose value shares that prefix and skips none, under SQLite's binary and NOCASE collations and Postgres's C and POSIX. Under any other Postgres collation neither bound is safe, so the next page of a list whose anchor row was deleted or edited answers `invalid_cursor` (400), and the client starts the list again: `listOptions` adds an `extras` flag that `paginate` reads, so pass its result to `findMany` whole. A reference binds at most what the plain value would in the keyset, so the cursor's share of the parameter budget below holds.

On D1, whose results travel as JSON, a REAL holding ±Infinity reads as null, so a cursor minted from such a row carries null. On a SQLite number key a null cursor value is read back from its row where the row holds ±Infinity, and stays null otherwise. Once that row is deleted the null may have stood for NULL, +Infinity or -Infinity, so the list resumes from the earliest of them in its order (NULL where NULLs come first, else -Infinity ascending and +Infinity descending), which repeats rows and skips none. Set `nonFinite: "exact"` beside `cursorSecret` only when your driver reads ±Infinity back as Infinity, as a local libsql file and bun:sqlite do: a null cursor is then a real NULL, and a deleted NULL anchor resumes right after it. D1, and any driver that returns ±Infinity as null, keep the default.

For drizzle's relational API, `queryHelpers.listOptions(query, { cursorScope, cursorSecret })` returns `limit`, `offset`, an `orderBy` callback (the sort, its null placement and the id tiebreak) and, on a cursor request, a `where: { RAW }` keyset predicate to AND with your own: `db.query.post.findMany({ limit, offset, orderBy, where })`.

`pagination.count` is the number of rows the filter matches across all pages, or `null` when the response cannot know it. Every builder hands back the columns `paginate` reads as `extras`: the tiebreak (`_combId`), an offset page's count (`_total`), and, on a cursor that carries a reference, whether its anchor is gone (`_combAnchorGone`); a merged SQLite list, a SQLite derived list with no `anchor`, and an anchored one sorted by an expression with no column, such as `count(*)`, also select the storage class of each sort key and of the tiebreak (`_combKeyTypes`), so a key libsql's `intMode: "string"` reads as a decimal string resumes as the integer SQLite stored, never as text, and a REAL ±Infinity, which D1 reads as null, resumes as itself; a Postgres derived list with no `anchor` selects each one's type family there (`float`, `fixed` or `other`), so a `double precision` past 2^53 pages and a `bigint` read as a number is refused. An anchored derived list sorted by a joined table's column does the same for that key, as its anchor row holds no such column: a joined integer past 2^53 is refused rather than resumed from a rounded number. Where such a key, or any key of a list with no `anchor`, is a time, the list also selects its stored value as text (`_combKeyTexts`): a Postgres `timestamp`, `timestamptz` or `date` as Postgres prints it, microseconds and `'infinity'` included, and a SQLite seconds-mode timestamp's REAL seconds, so a cursor resumes from the stored value rather than the millisecond Date the driver read. A Postgres `numeric` read in number mode carries its text the same way on every list, `listOptions` included, and an expression of `numeric` type or of a type of the database's own that is no float does on a derived list. A merged list selects none. Select them beside your columns, `db.select({ ...columns, ...built.extras })` or `findMany({ extras: options.extras })` (`applyListQuery` does it for you), and pass the rows with the built query to `queryHelpers.paginate(rows, built)`, which strips them. To put them into raw SQL, render each as `` sql`${extra.sql} AS ${sql.identifier(extra.fieldAlias)}` ``: interpolating the aliased extra itself renders only its quoted name, which SQLite reads as the string `'_combId'`. Rows that lack one the builder selected are a 500 (`page_not_wired`) naming it, on every page, so a forgotten count or flag is never read as none. An offset page reports the total (`0` for an empty first page). On one database a page past the end reports `null`, since no row carried the count and knowing it would take a second query; a merged page past the end reports the total, as every shard counted from its first row. A cursor page reports `null` too, and selects no count: a `count(*) over()` window would make the database read every remaining row on each page, which is the cost keyset pagination exists to avoid (and on D1, rows read are billed). The tiebreak id keeps its JSON type in the cursor, so a numeric id compares as a number even when it is an expression with no column affinity. Every value a cursor carries must be a string, number, bigint, boolean, `null` or date; anything else is `invalid_cursor`. A number holds ±Infinity and NaN too, as a Postgres `double precision` or a SQLite `REAL` may. A Postgres `timestamp` in date mode pages exactly even where it holds `'infinity'`: node-postgres reads `'infinity'` and `'-infinity'` both as 2000-01-01 local time, so a cursor's bound on such a key is read from its own row, exactly as the order compares it. Once that row is deleted, the cursor resumes from its Date, or from the list's own end when the Date is that 2000-01-01, which repeats rows and skips none: a deleted `'infinity'` anchor ascending (or `'-infinity'` descending) starts the list again from its beginning, as node-postgres reads both infinities as one value. A `timestamptz` or `date` in date mode reads `'infinity'` and `'-infinity'` as a Date no JS Date holds, and so does a SQLite timestamp holding ±Infinity on bun:sqlite and libsql (D1 reads it as null, above). A cursor carries that Date as itself, never as the null group, and its bound is read from its row: exact while the row holds its infinity, and once the row is deleted or made finite, the list resumes from the direction's own end, repeating rows and skipping none. A derived list has no row to read, so there it is a 500 (`sort_not_wired`) on the page that meets one.

```ts
import { createCursor, MIN_CURSOR_SECRET_BYTES, readCursor, sortSignature } from "@lovrozagar/comb/query"
```

### Zod schemas

`createListQuerySchema()` declares what an endpoint permits and returns the Zod schema that parses the raw query string into what `buildListQuery()` takes:

<!-- ts-context
declare const request: { query: Record<string, string> }
-->

```ts
import { createListQuerySchema } from "@lovrozagar/comb/query"

const postQuery = createListQuerySchema({
	filter: { created_at: "date", minute_read: "number", status: "enum", title: "string" },
	sort: ["created_at", "title"],
	search: ["title"], // publishes and accepts `q`
	fields: { scalars: ["id", "title", "created_at"] }, // publishes and accepts `select`
	lang: true, // publishes and accepts `lang`
	pagination: { defaultLimit: 20, maxLimit: 100, maxPage: 10_000 },
	limits: { maxConditions: 20, maxDepth: 3, maxInValues: 50, maxValues: 60, maxSearchTerms: 8, maxSortKeys: 3 },
})

const parsed = postQuery.parse(request.query)
```

The object is strict and each optional parameter exists only when the endpoint honors it: `filter` needs at least one filter field, `q` needs `search`, `select` needs `fields`, `lang` needs `lang: true`. Anything else is a 400 — a parameter the handler would ignore can no longer answer with the unfiltered list. Declaring `search` obliges the handler to pass a resolver: `buildListQuery()` throws `search_not_wired` on a `q` it has no resolver for.

`tiebreak` names the column the list breaks ties on, published on `x-comb` as `stableTiebreak` for a client that walks pages; it defaults to `id`, the property `buildListQuery` breaks ties on, and a derived list whose `idColumn` is another column names that column's name. An empty `tiebreak` is a `TypeError`. The parsed output carries it as `tiebreak`, and `buildDerivedListQuery` holds its `idColumn` (or its anchor's) to it: a column of another name is a `TypeError` at build that names both, as the list would break ties on one column and publish another.

`page` runs from 1 to `pagination.maxPage` (10 000 by default, published as `maxPage` on `x-comb` and as the param's `maximum`); past it a client pages by cursor, as an offset that deep makes the database skip every row before it. A page past `maxPage` throws `CombError` `page_too_deep` (400) from `parse`, `safeParse` and `~standard.validate` alike, as `readCursor` throws `invalid_cursor`, so it reaches your error handler with the key a list no schema bounded answers; `safeParse` does not return it as an issue. A page that is no whole number from 1 in decimal digits (`0`, `1.5`, `0x10`, `1e3`) throws `invalid_page` (400) the same way, as `buildListQuery` and `paginate` answer it. `limit` takes decimal digits too, and any other spelling stays a validation issue. A limit no schema checked, one an app writes itself, is held to a whole number from 1 by every list builder, as a page is, or it is `invalid_page` (400) naming the limit. A `maxPage` whose last offset, `(maxPage - 1) * maxLimit`, would pass 2^53 - 1 is refused when the schema is built. So is a `maxLimit` that is no whole number from 1, or a `defaultLimit` that is no whole number from 1 to `maxLimit`, each a `TypeError` naming the key; a `maxLimit` below 20 given alone needs a `defaultLimit` too, as the default of 20 would pass it. `extend` adds params of your own, validated and returned as they are; it may not take a name the schema owns (`cursor`, `filter`, `filterAst`, `lang`, `limit`, `limitBound`, `order`, `page`, `pageBound`, `parsedFields`, `parsedSort`, `q`, `select`, `sortOrderBy`, `tiebreak`, `validated`), which the type refuses and the builder throws a `TypeError` for, since an extension under one would replace a value the schema checked.

The `filter`, `order`, `q`, `limit` and `select` descriptions, examples and the `order` pattern are generated per endpoint from the same config (`filterParamMeta()`, `orderParamMeta()`, `searchParamMeta()`, `limitParamMeta()`, `selectParamMeta()`), and `cursor` publishes no example, so a spec lists the real fields, types, operators and limits even after a publisher strips `x-*`. The schema also carries the `x-comb` query facts — `filterFields` with operators, `sortable`, `nulls`, `searchable`, `selectable`, and the limits, the byte caps `maxFilterBytes` and `maxSearchBytes` among them — see `packages/core/docs/meta-contract.md`.

`createRetrieveQuerySchema()` is the single-resource counterpart: `select`, and `lang` when its config says `lang: true`. It is strict too, so a `filter` sent to a single-resource endpoint is a 400 rather than a 200 that ignored it, and its `extend` may not take `lang`, `parsedFields` or `select`. `paginationResponseSchema` is exported for the response envelope. A list request is validated by `createListQuerySchema()` alone, and `buildListQuery()` refuses a filter or sort that did not come through it (see [SQLite SQL generation](#sqlite-sql-generation)).

### SQLite SQL generation

<!-- ts-context
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
declare const db: import("drizzle-orm/libsql").LibSQLDatabase
declare const parsed: import("@lovrozagar/comb/query").ListQueryOutput
declare const env: { CURSOR_SECRET: string }
const post = sqliteTable("post", { _search: text("_search"), created_at: integer("created_at"), deleted_at: integer("deleted_at"), id: text("id").primaryKey(), title: text("title") })
-->

```ts
import { applyListQuery, buildListQuery, likeSearch } from "@lovrozagar/comb/query/sqlite"
import { queryHelpers } from "@lovrozagar/comb/query"
import { getTableColumns, isNull, sql } from "drizzle-orm"

const result = buildListQuery({
	cursorScope: "post:list", // the list: its route, and its tenant where it has one
	cursorSecret: env.CURSOR_SECRET, // opens a cursor's seal
	parsed, // postQuery.parse(request.query)
	table: post,
	baseWhere: isNull(post.deleted_at), // ANDed in — soft deletes, tenant scoping, access rules
	search: likeSearch(post._search), // a column searchText(title) wrote
	computedSorts: { popularity: (dir) => sql`view_count ${sql.raw(dir)}` },
})

const rows = await applyListQuery((extras) => db.select({ ...getTableColumns(post), ...extras }).from(post), result)
const [items, pagination] = queryHelpers.paginate(rows, result)
```

`parseFilter()` keeps filter values as strings; `validateFilter()` and the list query schema type them, so declared `number` and `date` fields bind as numbers and `boolean` as booleans, and a computed resolver receives the declared type. `buildListQuery()` and `filterToSQL()` expect that validated AST. A condition they cannot run, a computed field without a resolver, a resolver that returns `null`, a relation field with no `relations` entry, throws `filter_not_wired` (500) rather than being dropped, which would answer with more rows than the filter asked for. A sort field the table has no column for, or a computed sort without a resolver, throws `sort_not_wired` (500) the same way.

A filter on a relation field (`tags.slug`, through a `relations` entry) asks about the related rows: `eq`, `in`, `like` and the other positives match a row that has a related row matching, and the negatives match a row that has none matching their positive, so `tags.slug.ne.red` is a post not tagged red, an untagged one included, and never a post `tags.slug.eq.red` matches. `nin` is no related row in the list, `is.null` no related row with a value (an untagged post among them), and `is.notnull` no related row without one.

`buildListQuery()` returns `{ extras, where, orderBy, limit, offset, search, meta, pagination }` — it builds clauses, it does not execute. `extras` are the columns `paginate` reads, selected beside yours; `pagination` is what `paginate(rows, built)` reads to page them. `applyListQuery(select, built)` is the one supported wiring: it makes your select over the extras and chains the rest onto it. A select you wire by hand, to interleave joins, must apply all of it: select `built.extras`, and chain `.where(built.where)`, `.orderBy(...built.orderBy)`, `.limit(built.limit)` and `.offset(built.offset)`. A select that forgets `.offset()` serves page 1 for every page, and one that forgets `.orderBy()` pages rows in no order; comb cannot see a select it did not make. `meta.type` tells you whether cursor or offset pagination won (cursor takes precedence), and `limit` is always one past the page, `parsed.limit + 1`, so `paginate` can tell there is a next page.

`buildListQuery()` and `queryHelpers.listOptions()` take a filter and an order only from the list query schema's output, which carries `validated: true`. A hand-built `filterAst` or `parsedSort` without it is refused (`filter_not_wired` / `sort_not_wired`, 500): checked against nothing, it could name any column of the table, `password_hash` included. Code that validated a filter against its own fields, as `validateFilter()` does, sets `validated: true` itself. The flag covers the filter and the order, never the page: a page is always a whole number from 1, and past the default `maxPage` (10,000) it is `page_too_deep`, unless it carries a `pageBound`, which the schema sets to the `maxPage` it was built with; then that number holds it. A limit is held the same way: past the default `maxLimit` (100) it is a 400, unless a `limitBound` states another. Each comes from the schema's config, never from a request, and a parsed query with a field changed stays held to them. Either on an input you make by hand is your app stating its own bound. `buildDerivedListQuery()` needs no flag: its caller passes the filter as SQL and maps every sortable field to a column.

`buildDerivedListQuery()` handles queries over a subquery or CTE, where sort columns come from a `sortColumns` map rather than the table. A derived list whose rows are one table, its sort columns that table's, names it as `anchor: { table, idColumn }`: a value too long for a cursor then goes by reference and is read back from that table, as on the table's own list. With `idColumn` alone no row holds its keys, so such a value is a 500 (`sort_not_wired`) on the page that meets it, and so is a sort key SQLite stores as INTEGER that the driver read as a number past ±(2^53 − 1), rounded (D1 always, bun:sqlite by default), which the next page would seek by; a REAL past 2^53 is a double on disk, read back exactly, and pages. On Postgres the same holds by type: a `bigint` read as a number past 2^53 is the 500, and a `double precision` or `real` pages. A `numeric` read in number mode is read as the nearest double, so 0.1000000000000000001 and 0.1000000000000000002 both read as 0.1: every list, derived or not, carries its text in `_combKeyTexts`, and the cursor binds that text as a `numeric`, exact whether or not its row is still there. Any other number under a type no double names, such as a domain's read through `mapWith(Number)`, is the 500 when it isn't a safe integer. Read such an integer as bigint, or name the `anchor`, whose row the keyset reads the exact key back from. A derived list must not dedupe with `DISTINCT`: SQL counts `_total` before `DISTINCT` runs, so the count would be the joined rows. Express such a join as `EXISTS` in `filterWhere`, or `GROUP BY` the id, which the count runs after. The list's database is read from the columns its id and sort columns hold, wherever an expression holds them; a list of SQL expressions alone, such as a union whose id is `` sql`inbox.uid` ``, states it with `dialect: "postgres"` or `dialect: "sqlite"`, and is a TypeError naming `dialect` without one, since Postgres types a key by its operand and SQLite by its storage class. A SQLite derived list whose rows sit on several shards, such as a union of two joined selects per shard, takes `merged: {}` (with `maxRowsPerShard`, as `buildListQuery`'s does): read each shard with `applyListQuery` and page the reads with `paginateMerged`. Its rows carry each sort field under its name, which the merge orders by, and it takes no `anchor`, as a merged list reads no key by reference. A merged Postgres derived list is a TypeError at build: the merge orders as SQLite does, while Postgres orders a `numeric` or `bigint` read as a decimal string, and text under the server's collation, in ways no in-memory merge can know.

`queryHelpers.paginate(rows, built)` takes the rows and the query that read them, any of the three builders' results (a merged list's goes to `paginateMerged`), and returns `[items, pagination]`; the built query's `pagination` says what it read, so nothing is passed twice. A list ordered by a computed sort, or a table with no tiebreak column, has no cursor to resume it: its `nextCursor` is `null` while `hasMore` still says there is a next page by number. More rows than the built query reads, one past the page, are a 500 (`page_not_wired`): rows a query read without its limit and offset are no page of this list. Underneath, `filterToSQL()` and `conditionToSQL()` are exported for advanced use, along with `orderSQL()` / `orderByKeys()` / `keysetSQL()` — the one ordering and keyset implementation every builder shares — and `patternToSQL()` for `like` / `ilike`.

Search comes in two flavours. `likeSearch(column)` is the portable fallback: it targets a `_search` column (or any SQL expression, such as `sql.raw('"_search"')` on a table drizzle does not declare), folds each whitespace-separated term with `searchText()`, finds it with `instr` in the expression's `lower()`, so no LIKE pattern meets D1's 50-byte cap, and ANDs the terms. A raw expression, such as a `title` column, is matched by ASCII case only: its accents and the other folds below match only in a column `searchText` wrote, so `café` and `cafe` both miss a raw `Café`. Write the column with the same function, `searchText(title, body, …)`, so the stored text and the query cannot drift apart: a column filled by SQL `lower()` misses every accented query. Its format, which a backfill must reproduce: the parts present joined by one space, NFKD-normalized (so ＦＩＬＥ and ﬁ fold), lowercased, Greek final sigma ς written σ (so an uppercase query ending in Σ finds the word), combining marks (U+0300–U+036F) removed except those that make a Cyrillic letter of its own, which NFC puts back into one letter (й, ї, ё, ў stay apart from и, і, е, у; a stress mark, as in доро́га, goes), Hebrew points and cantillation (U+0591–U+05C7), Arabic harakat and Quranic marks (U+0610–U+061A, U+064B–U+065F, U+0670, U+06D6–U+06ED) and the tatweel (U+0640) removed, so שָׁלוֹם is שלום and مـحـمّد is محمد, the Latin letters with no decomposition spelled in ASCII (ß ss, æ ae, œ oe, ø o, ł l, đ d, ð d, þ th, ı i, ĸ k, ŋ n, ŧ t, ħ h), then NFC-composed again, so й and Hangul syllables stay whole. Greek accents fold (ά is α). A change to this format means rewriting every `_search` column; 0.11 changed it, and "Upgrading to 0.11" says how to refold. `refoldStatements(table, column, sources)` from `@lovrozagar/comb/query/sqlite` is that rewrite: its `select` reads each row's rowid, its sources and the text it stores, and `updates(rows)` gives one `UPDATE` per row whose fold differs, so a second run writes nothing. Run the select, then the updates in batches your driver takes (`db.batch` on D1). It needs the table's rowid. `buildFtsMatch()`, `buildFtsWhere({ table, ftsTable }, q)`, and `buildFtsHighlight()` target the FTS5 tables the `fts` generator created, and `buildFtsWhereWithSpellfix(db, { table, ftsTable, spellfixTable }, q)` adds spellfix1 fuzzy matching where the extension is available. It asks each database client once, before any spellfix query, with `editdist3`, the function spellfix1 registers, which reads no table: without the extension (stock bun:sqlite and libsql) the terms are searched as typed, and with it a missing or misspelled spellfix table, or a transient driver error, is thrown. The answer is kept per client a drizzle wrapper holds (`db.$client`), so a server that builds a wrapper per request asks once per client. D1 loads no extension, so a D1 client, the binding or a session `openD1Session` opens per request, is never asked and its terms are searched as typed. `spellfix: false` asks nothing and searches the terms as typed, for any other database that never has the extension. Every term becomes a bound prefix phrase, `"term"*`, so `post` finds `postgres`; FTS5 syntax in user text (`*`, `:`, parentheses, `AND`/`OR`/`NOT`) is quoted, never interpreted: inside its quotes every word and character of a term is searched as text, so `not found` needs both words and `error:timeout` finds that text. `sanitizeFtsTerm()` is the per-term cleaning: it removes control characters and skips a term with no letter or digit, which no token matches and which would otherwise empty the search. The FTS table name is a single identifier, quoted with `quoteIdent`. The generated FTS tables are keyed by their content table's `rowid`, so `buildFtsWhere` emits `<table>.rowid IN (SELECT rowid FROM <fts> WHERE <fts> MATCH ?)`: the rowid is qualified by the drizzle table you pass, so a join cannot make it ambiguous and a text `id` column never stands in for it. FTS5's `unicode61` tokenizer folds less: not ß to ss, æ to ae, a ligature such as ﬁ, halfwidth kana or a Greek accent. So an FTS table over the raw text misses a query typed in one of those folds, and one over a `searchText` column misses a query typed as written, unless the source says so: `buildFtsWhere({ folded: true, ftsTable, table }, q)` (and `buildFtsWhereWithSpellfix`, and `buildFtsMatch(name, q, { folded: true })`) folds each term with `searchText` first, so FTS over `_search` applies the folds `likeSearch` applies, per token prefix. It still finds less in two ways. FTS matches a term at the start of a token, where `likeSearch` matches a substring anywhere: `asse` finds no `reassess`, and a term inside an unspaced CJK, Thai or Hangul run (`都庁` in `東京都庁`, `국어` in `한국어`) finds no row, as the run is one token. And FTS drops symbols, which `unicode61` does not index, so `c++` searches `c*` and finds every row with a word that starts with c.

### Translations

`resolveTranslation()` picks one row out of an array of translation rows: the requested `lang`, else `defaultLang`, else the first available. It returns that row's fields under that row's own language code, so fallback content is never labeled as the requested language, and a field the row lacks stays empty rather than being filled from another language. `fields` narrows the returned keys (`null` keeps all), and `languageCodeKey` names the discriminator column (default `languageCode`). It is pure and dependency-free, so it runs equally well over rows Drizzle already loaded via `with`.

<!-- ts-context
declare const post: { post_translation: Array<{ body: string; languageCode: string; title: string }> }
-->

```ts
import { resolveTranslation } from "@lovrozagar/comb/query"

const localized = resolveTranslation({
	translations: post.post_translation,
	lang: "pt-BR",
	defaultLang: "en",
	fields: ["title", "body"],
})
```

## Cloudflare D1

### Loading a `wrangler d1 export`

An export, from `wrangler d1 export <db> --remote --output dump.sql`, lists its tables by name and each table's rows after its own `CREATE TABLE`. So a child's rows can come before its parent's table, and the file does not load as written into a database with foreign keys on. To load it, into a local copy or a restore, reorder it: `PRAGMA defer_foreign_keys = on` first, then every `CREATE TABLE`, then the rest (rows, indexes, triggers). `splitSqlStatements` from `@lovrozagar/comb/migrate` splits the file quote-aware. An export blocks the database's requests while it runs, so take a production export off-peak, and take a Time Travel bookmark with it.

### Sessions

<!-- ts-context
import { defineRelations } from "drizzle-orm"
declare const env: { DB: D1Database }
declare const bookmarkFromCookie: string | undefined
const relations = defineRelations({})
-->

```ts
import { openD1Session } from "@lovrozagar/comb/sqlite/d1/session"
import { drizzle } from "drizzle-orm/d1"

const { client, session } = openD1Session(env.DB, { bookmark: bookmarkFromCookie })
const db = drizzle(client, { relations })
```

A bookmark guarantees the client never sees state older than its own last write. Without one the session opens on the primary (`first-primary`), so a read sees every write before it; pass `{ constraint: "first-unconstrained" }` for a read that may lag, such as a public page, to read from the nearest replica. An empty bookmark counts as none. If `withSession` is missing — miniflare, older runtimes — it returns the raw handle and `session: undefined`, so the same code path works locally.

### Bookmarks

<!-- ts-context
declare const session: D1DatabaseSession | undefined
declare function setCookie(name: string, value: string): void
-->

```ts
import { BookmarkTracker } from "@lovrozagar/comb/sqlite/d1/bookmark"

const tracker = new BookmarkTracker()
tracker.track(session, "core")
/* after the response body is settled */
for (const { tag, bookmark } of tracker.getBookmarks()) setCookie(tag, bookmark)
```

`track` takes `openD1Session`'s `session` as it comes: on a runtime without sessions it is `undefined`, and `track` does nothing. `getBookmarks()` skips sessions that never committed rather than throwing, so it is safe to call unconditionally at the end of a request.

### Sharding

<!-- ts-context
type Env = { CORE_DB: D1Database; SHARDS: KVNamespace }
declare const orgId: string
-->

```ts
import { ShardRouter, shardMap } from "@lovrozagar/comb/sqlite/d1/sharding"

/* module scope — the LRU must outlive the request */
const router = new ShardRouter({ totalShards: 16, maxOrgsPerShard: 500 })

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const mapping = await router.resolveOrAllocate(orgId, { coreDb: env.CORE_DB, kv: env.SHARDS }, ctx)
		// …
	},
}
```

Resolution is three tiers: a per-isolate LRU with stale-while-revalidate, then KV, then the core D1 `shard_map` table (exported as a ready-to-use Drizzle table). The core read goes to the nearest replica, and to the primary when the replica has no mapping, since a fresh placement may not have reached it yet. A miss on the primary is remembered in the isolate for `missTtlMs` (5 s, at most `lruMaxSize` orgs), so a run of requests for an unknown id reads the primary once; `place`, `move` and `invalidate` forget it. Revalidation of a stale LRU entry is handed to `ctx.waitUntil()`, so it never sits in the request's critical path, and concurrent requests that see the same stale entry share one revalidation.

A new org goes to the shard `pick({ orgId, counts, totalShards })` names, where `counts` maps each D1 shard to its live orgs (a shard with none is absent). It may be async. The default takes the shard with the most headroom under `maxOrgsPerShard`, the lowest on a tie. When `pick` names none, allocation throws `CombError` `shards_full` (503); a shard outside `0` to `totalShards - 1` throws a `RangeError`. The counts are read before the insert, so isolates allocating at once can each take a shard's last place: `maxOrgsPerShard` is a soft cap. A new org's insert does nothing when another isolate inserted first, and the row read back afterwards is the winner's, so two isolates racing on an org's first request agree on one mapping. A soft-deleted org (`deleted_at` set) is revived on the shard it had, where its data is, without asking `pick`; `log` reports it as an allocation with `revived: true`.

To place orgs yourself, `place({ orgId, shardId }, deps, ctx)` writes the same way: the first writer wins, an org that has a row keeps its shard, and the mapping that stands is returned. `move({ orgId, shardId }, deps, ctx)` overwrites the mapping and invalidates it; moving the org's rows is yours. Your own writes on the core database for the move, such as its members' presence rows, go in `with`, prepared statements that run in one batch with the mapping's write, so the switch and they land together or not at all: `move({ orgId, shardId, with: [coreDb.prepare(…).bind(…)] }, deps, ctx)`. A failed batch writes nothing and invalidates nothing. `unplace(orgId, deps)` soft-deletes the mapping and invalidates it, and a later `place` or allocation revives the org on its shard.

`invalidate(orgId, kv)` clears this isolate's LRU entry after a manual remap, puts a tombstone under its own key (`shard-inv:<orgId>`) carrying a random nonce, and deletes the mapping from KV, so a router of an older version sharing the KV in a rolling deploy finds a plain miss; `move` and `unplace` call it, `move` after its own write commits, warming KV with the moved row tagged with the nonce. KV has no compare-and-set, and a read from a lagging replica can return the row from before a remap, so what counts is decided at read time, with no clock: while the tombstone lives (3 × `kvTtlSeconds`), a KV mapping is trusted only when it is tagged with its nonce. Any other, such as a fill that read before the remap or from a replica behind it, is a miss: the reader reads the primary and puts the mapping tagged. The isolate that invalidated holds the nonce itself, so it is never misled, even before KV shows the tombstone. Other isolates keep serving their LRU copy until it goes stale (`lruTtlMs`, 5 min), then revalidate from KV or the core table; an entry is never served past `lruHardTtlMs` (15 min). KV is a cache: a KV call that fails is logged, and a write that fails is skipped, so a `move` whose core write committed does not throw for it. A read that fails trusts nothing in KV, as a tombstone it could not read may be shadowing the mapping: the request reads the primary and caches what it read in its own LRU, never in KV. A `place` or revive in an isolate that holds a live tombstone for the org tags its KV write with it, so other isolates trust it. The outer bound: a replica still behind a remap 3 × `kvTtlSeconds` after it could cache the old shard again once the tombstone expires; D1's replicas lag by seconds. So a remap converges everywhere once the tombstone has reached a location (KV propagates in up to about 60 s), plus `lruTtlMs` for an isolate already holding the org: keep both shards readable for that long, or resolve with `resolveVerified(orgId, { coreDb, kv, present }, ctx)`. It resolves as `resolve` does, then asks `present(mapping)` whether the org's rows are on that shard; when they are not, it reads the primary past every cache. When the primary names the shard just probed (the rows may not be written yet), that mapping is returned with nothing written or logged; otherwise the org is invalidated, the primary read again, and that mapping, or `undefined` for an org since unplaced, returned without probing again, cached only when no `move` or `invalidate` in this isolate came meanwhile.

Tunables: `lruMaxSize` (1000), `lruTtlMs` (5 min), `lruHardTtlMs` (15 min), `kvTtlSeconds` (60), `missTtlMs` (5 s), `maxOrgsPerShard` (500), `pick`. The constructor throws a `RangeError` unless `totalShards` and `maxOrgsPerShard` are positive integers and `kvTtlSeconds` is an integer of at least 60, KV's floor for an expiration TTL: under it every put fails, so KV would cache nothing. An org id is at most 64 UTF-16 code units, the length `shard_map.org_id` holds (`ORG_ID_MAX_LENGTH`): `place`, `move` and `allocate` (so `resolveOrAllocate`) throw a `RangeError` for a longer one, and `resolve` answers it as a miss. A route that takes the org id from its path validates it first. Pass `log(event, data)` for a structured hook: `shard-router.hit` (`{ orgId, tier: "lru" | "kv" | "d1" }`, plus `stale` on an LRU hit), `shard-router.miss` (`{ orgId }`, also for an id longer than `shard_map.org_id`'s 64 characters, answered before KV, whose keys stop at 512 bytes), `shard-router.allocate` (`{ orgId, shardId }`, plus `revived: true` for a revived org, from allocation and `place`, once per row written: a `place` or allocation of an org already placed, or the isolate that lost a race to place it, logs none), `shard-router.move` (`{ orgId, shardId }`), `shard-router.reresolve` (`{ orgId, from, to }`, `to` undefined for an org since unplaced), `shard-router.kv.error` (`{ orgId, op: "get" | "put" | "delete", error }`) and `shard-router.revalidate.error` (`{ orgId, error }`). With no `log`, the two `.error` events go to `console.warn`; pass `log: () => {}` to mute them.

A list whose rows sit on several shards, such as a user's orgs across the shards they have presence on, is merged in memory. Build it once, `buildListQuery({ cursorScope, cursorSecret, merged: {}, parsed, table, … })` with its filter, search and `baseWhere` as for one database; read each shard with that one query, its `extras` selected (`applyListQuery` does it), and pass the rows of all of them with it to `paginateMerged(rowsPerShard, built)`, which returns `[items, pagination]` as `queryHelpers.paginate` does. The shards are SQLite: the merge orders as SQLite does, so a merged list over a Postgres table is a `TypeError` at build, as a merged Postgres derived list is. A merged list's query is paged by `paginateMerged` alone, and a single database's by `paginate` alone: the types keep them apart, and each refuses the other's as a 500 (`page_not_wired`), as it refuses a shard's rows that lack the count or the tiebreak. A cursor page reads the page and one more past the cursor from each shard; a page by number reads every row up to its end from each, as any shard may hold any of them, and each shard counts its part, so `pagination.count` is the whole list's and `page=N` gives page N. The merge orders as SQLite does: text by code point (its BINARY collation), numbers before text, the null placement the order names, then the id, so the merged list pages by number or by cursor exactly as one database holding every row would. That holds for sort keys under SQLite's default BINARY collation, which is every column drizzle declares: a column a migration declared `COLLATE NOCASE` or `RTRIM` orders each shard by its fold, which the merge cannot know. `paginateMerged` throws `sort_not_wired` (500) when a shard's own rows come back out of its order, but a case pair that sits on two shards is past seeing, so keep a merged list's sort keys BINARY. A sort key SQLite stores as INTEGER past ±(2^53 − 1) that the driver reads as a JS number (D1 always does, as does bun:sqlite by default) is already rounded, so two such keys on two shards could merge in the wrong order: `paginateMerged` refuses one as `sort_not_wired` (500), as it does such a tiebreak; read it as bigint (libsql's `intMode: "bigint"`, bun:sqlite's `safeIntegers`), or keep it within the bound. A REAL key past 2^53 is exact as a double and merges in order, and a REAL ±Infinity, which D1 reads as null, merges as itself. Its ids must be unique across the shards, as a cursor names one row by its id: `paginateMerged` throws `sort_not_wired` when two shards return the same id, though only for rows it was given. A cursor page serves no row at or before the cursor, and none past the earliest last row of a shard that read its whole page and one more, so a shard that resumed early, as one reading a NULL key's anchor does, neither repeats nor skips rows. Offset pages cost every shard the rows before them, so a page whose end passes `maxRowsPerShard` (1001 rows by default, `merged: { maxRowsPerShard }`) throws `page_too_deep` (400): page a deep merged list by cursor. A cursor names its row by value, never by reference, as only one shard holds the row a reference reads back: a sort key too long for a cursor is a 500 (`sort_not_wired`) on the page that meets it, so a merged list's sort keys must fit the cursor.

## Meta contract

comb stamps facts about your tables and queries onto the schemas it generates, so a document
generator downstream can publish them without re-deriving anything.

<!-- ts-context
declare const postDtoReadSchema: import("zod").ZodType
-->

```ts
import { readCombEntityMeta } from "@lovrozagar/comb/meta"
import * as z from "zod"

readCombEntityMeta(z.toJSONSchema(postDtoReadSchema))
// { v: 1, kind: "entity", name: "post", identity: "id",
//   generated: [...], immutable: [...], softDelete: "deleted_at",
//   tenantColumn: null, uniqueIndexes: [{ columns: ["title"], name: "idx_post_title" }] }
```

Two producers stamp automatically: the DTO generator puts `CombEntityMeta` on each read schema,
and `createListQuerySchema` puts `CombQueryMeta` on what it returns — built from the same config
object that parses the request, so the published facts cannot drift from the parser's behavior.

Everything rides on one reserved JSON Schema key, `x-comb`, carrying a version. Readers ignore
unknown fields and refuse a payload newer than they understand rather than guessing at it.

`combMeta()` stamps, `readCombMeta()` / `readCombEntityMeta()` / `readCombQueryMeta()` read, and
`carryCombMeta()` re-stamps after a `.extend()` (which drops Zod metadata silently). The full
contract — wire format, versioning rules, and what comb deliberately does not claim to know — is
in [`packages/core/docs/meta-contract.md`](packages/core/docs/meta-contract.md).

## Utilities

```ts
import { createUlidFactory, generateId, generateUlid, LruCache } from "@lovrozagar/comb"

generateUlid() // "01jqx8r4m2n7p3q5s6t8v9w0xy" — lexicographically sortable
generateId("pst") // "pst_01jqx8r4m2n7p3q5s6t8v9w0xy"

const ids = createUlidFactory()
ids.ulid() < ids.ulid() // true, even within one millisecond
ids.id("pst")
```

ULIDs use Crockford base32 with a 10-character timestamp and 16 characters of randomness, so ids sort by creation time and index well as text primary keys. `generateId()` validates the prefix against `^[a-z][a-z0-9]{1,9}$`.

`generateUlid()` and `generateId()` are ordered by millisecond only: two ids from the same millisecond compare at random. When order must be strict, hold a `createUlidFactory()`: within one millisecond it counts the random part up by one, it holds a clock that steps back at the last time it issued, and it moves to the next millisecond rather than wrap. The state lives in the factory, so it is shared only where you share it. `{ now, random }` options replace the clock and the randomness, for tests.

`LruCache` is the cache behind the shard router, exported on its own: bounded size, a soft TTL that marks entries stale for stale-while-revalidate (`getWithMeta()` returns `{ value, stale }`), and a hard TTL that evicts. With a hard TTL, an entry's soft TTL is at most the hard one, and an entry with none is fresh until the hard expiry; no read, `get()`, `has()` or `getWithMeta()`, serves an entry past it. Its constructor throws `RangeError` for a `maxSize` that is not a positive integer, a TTL that is not positive, or a `hardTtlMs` shorter than `ttlMs`, any of which would leave it unbounded or never expiring.

## Package exports

| Specifier                                    | Contents                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@lovrozagar/comb`                           | `CombError`, `createUlidFactory`, `generateId`, `generateUlid`, `LruCache`, error keys and types   |
| `@lovrozagar/comb/types`                     | `StatusKey`, `ConstraintMap`, `DatabaseErrorHandler`, …                                            |
| `@lovrozagar/comb/cli`                       | `runCli(argv, io)`: run the CLI in process and get its exit code                                   |
| `@lovrozagar/comb/codegen`                   | `analyze`, `validateTables`, `fieldConstraintsOf`, analysis types                                  |
| `@lovrozagar/comb/codegen/generators`        | every `generate*` function                                                                         |
| `@lovrozagar/comb/meta`                      | `combMeta`, `readCombMeta`, `readCombEntityMeta`, `readCombQueryMeta`, `carryCombMeta`, meta types |
| `@lovrozagar/comb/migrate`                   | config, providers, apply, parse, Atlas helpers                                                     |
| `@lovrozagar/comb/query`                     | filter, order, select, cursors, Zod builders                                                       |
| `@lovrozagar/comb/query/sqlite`              | SQL generation, FTS5, JSON helpers                                                                 |
| `@lovrozagar/comb/sqlite/columns`            | `c` for SQLite                                                                                     |
| `@lovrozagar/comb/sqlite/constraints`        | constraint types                                                                                   |
| `@lovrozagar/comb/sqlite/patterns`           | shared regex patterns                                                                              |
| `@lovrozagar/comb/sqlite/constraint-handler` | `sqliteErrorHandler`, `classifySqliteError`, `handleConstraintViolation`                           |
| `@lovrozagar/comb/sqlite/d1/session`         | `openD1Session`                                                                                    |
| `@lovrozagar/comb/sqlite/d1/bookmark`        | `BookmarkTracker`                                                                                  |
| `@lovrozagar/comb/sqlite/d1/error-handler`   | `d1ErrorHandler`, `classifyD1Error`                                                                |
| `@lovrozagar/comb/sqlite/d1/sharding`        | `ShardRouter`, `shardMap`                                                                          |
| `@lovrozagar/comb/states`                    | `defineStateMachine`, `canTransition`, `assertTransition`, `nextStates`, `isState`, `isTerminal`   |
| `@lovrozagar/comb/pg/columns`                | `c` for PostgreSQL                                                                                 |
| `@lovrozagar/comb/pg/error-handler`          | `pgErrorHandler`, `classifyPgError`                                                                |

## Repository layout

```text
comb/
├── packages/core/          the @lovrozagar/comb package
│   ├── src/
│   │   ├── codegen/        analyzer + generators
│   │   ├── migrate/        config, drivers, Atlas integration
│   │   ├── pg/             PostgreSQL columns and error handling
│   │   ├── query/          DB-agnostic query layer + SQLite lowering
│   │   ├── sqlite/         SQLite columns, constraints, D1
│   │   │                   (unit tests sit beside each file as <name>.test.ts)
│   │   ├── bin.ts          the `comb` executable (a shim over runCli)
│   │   ├── cli/            runCli(argv, io): argument parsing, codegen, migrate
│   │   └── index.ts
│   ├── lint/           the comb oxlint plugin, each rule beside its test
│   └── tests/
│       ├── integration/    vitest on real engines and cross-module contracts
│       ├── structure/      layout and boundary invariants
│       └── bun/            bun:test — needs bun:sqlite
├── .githooks/commit-msg    Conventional Commits gate
└── .github/workflows/      ci + release
```

## Develop

```bash
bun install
```

Then, from the repo root — CI runs the same set:

```bash
bun run fmt          # oxfmt, rewrites in place
bun run lint         # oxlint
bun run typecheck    # tsc --noEmit
bun run test         # vitest
bun run test:bun     # bun test — the bun:sqlite replay suite
```

`bun run test:all` runs both suites in sequence, and `bun run test:watch` is vitest in watch mode.

`tests/bun/` is separate because it imports `bun:sqlite` and `bun:test`, which vitest cannot load. It replays a full Atlas-shaped drift migration against an in-memory database to prove the SQLite transforms survive a real commit with foreign keys enforced.

Commits follow [Conventional Commits](https://www.conventionalcommits.org). `bun install` points `core.hooksPath` at `.githooks`, so the `commit-msg` hook enforces it locally; CI re-checks every commit on a pull request.

## Upgrading to 0.21

What changes for a project on 0.20. Before deploying it:

1. **Know what changed in the API.** A test holds these three lists to the exports themselves.

   New exports: `BinPeer`, `ClassifyOptions`, `ColumnsConfig`, `CombColumnKind`, `ConstantValue`, `ConstraintsConfig`, `CursorId`, `D1AnswerLike`, `D1DatabaseLike`, `D1SessionLike`, `D1StatementLike`, `DatabaseShared`, `DiagramsConfig`, `DtosConfig`, `EntitiesConfig`, `EnumChecksConfig`, `EnvironmentsDatabaseConfig`, `ExpressionIndexMeta`, `Fallback`, `FieldNamesConfig`, `FilterToSQLConfig`, `ForeignKey`, `FtsGeneratorConfig`, `FtsObject`, `FtsSource`, `FtsState`, `GeneratorContext`, `ImportRef`, `ImportStyle`, `KeysetKind`, `LimitsGiven`, `ListPagination`, `ListQuery`, `ListQueryAppliable`, `ListQueryRequest`, `ListQueryShape`, `LogFn`, `ManifestConfig`, `MappedColumn`, `MetaCarrier`, `OrmConfig`, `OrmDialect`, `OutputStableShape`, `PaginationConfig`, `PaginationResponse`, `PaginationResponseSchema`, `ParamMeta`, `PartialUniqueIndexMeta`, `PgColumns`, `PgTarget`, `PostgresDriver`, `ProviderDeps`, `ReadOptions`, `RelationalTable`, `RelationsConfig`, `ReservedListKey`, `ReservedRetrieveKey`, `RetrieveRequest`, `RetrieveShape`, `RowsConfig`, `Run`, `RunOptions`, `RunResult`, `SessionOf`, `ShardBindingOf`, `ShardEnv`, `ShardMapColumns`, `ShardMapTable`, `SingleDatabaseConfig`, `SpellfixRow`, `SqliteDriver`, `StateMachineMeta`, `TableInfo`, `TargetKind`, `Terminal`, `TranslationsConfig`, `TriggerEvent`, `TursoCredentialsRequest`, `TursoDeps`, `ValidationResult`, `WaitUntilCtx`, `drizzleListOptions`, `drizzleProject`, `extractFilterValue`, `extractFilterValues`, `jsonValue`, `limitParamMeta`, `paginate`, `selectParamMeta`.

   Removed: `CURSOR_EXAMPLES`, `LIMIT_DESCRIPTION`, `LIMIT_EXAMPLES`, `SELECT_EXAMPLES` (step 35).

   Changed: `BuildDerivedListQueryOpts`, `BuildListQueryOpts`, `CircuitBreakerState`, `CliError`, `CliIo`, `CodegenConfig`, `CombError`, `CombMeta`, `CombMetaInput`, `CombMetaStamp`, `CombQueryMeta`, `CombQueryMetaInput`, `Connection`, `ConnectionProvider`, `ConstraintMap`, `ConstraintMapEntry`, `CursorValue`, `DatabaseCodegen`, `DatabaseErrorHandler`, `DecodedCursor`, `DrizzleExportOptions`, `DrizzleListOptions`, `EnumOptions`, `EnumStates`, `FieldsConfig`, `IntegerConstraints`, `JsonConstraints`, `ListExtra`, `ListExtras`, `ListQueryConfig`, `ListQueryInput`, `ListQueryOutput`, `ListQueryResult`, `ListQuerySchema`, `ListRow`, `LruCache`, `MANIFEST_VERSION`, `Manifest`, `ManifestColumn`, `ManifestEntity`, `ManifestRelation`, `MergedListQueryResult`, `MigrationResult`, `RetrieveQueryConfig`, `RetrieveQuerySchema`, `RetryOptions`, `SchemaDiffOptions`, `SessionHandle`, `ShardDbHandle`, `ShardKv`, `ShardResolverDeps`, `ShardRouter`, `ShardRouterConfig`, `ShardVerifyDeps`, `SpellfixSearch`, `SqliteColumns`, `StateMachine`, `TextConstraints`, `TimestampConstraints`, `TranslationResolverInput`, `UlidFactoryOptions`, `analyze`, `applyListQuery`, `assertTransition`, `buildDerivedListQuery`, `buildFtsWhereWithSpellfix`, `buildListQuery`, `buildManifest`, `c`, `canTransition`, `checkAtlasInstalled`, `checkCircuitBreaker`, `classifyD1Error`, `classifyMigration`, `classifyPgError`, `classifySqliteError`, `combMeta`, `constraintError`, `createBunSqliteProvider`, `createCircuitBreaker`, `createCursor`, `createD1Provider`, `createLibsqlProvider`, `createListQuerySchema`, `createProvider`, `createRetrieveQuerySchema`, `createTursoProvider`, `createUlidFactory`, `d1ErrorHandler`, `defineCodegenConfig`, `defineConstraintMaps`, `defineStateMachine`, `deriveEntityMeta`, `exportDrizzleSchema`, `extractDropStatements`, `fieldConstraintsOf`, `generateColumns`, `generateDtos`, `generateEntities`, `generateFieldNames`, `generateOrm`, `generateSchemaDiff`, `getAtlasVersion`, `getSqliteColumns`, `getSqliteIndexes`, `getSqliteTables`, `getTursoCredentials`, `handleConstraintViolation`, `introspectSqliteSchema`, `isState`, `isTerminal`, `nextStates`, `openD1Session`, `paginateMerged`, `parseMigration`, `parseOrder`, `patterns`, `pgErrorHandler`, `processIo`, `queryHelpers`, `readCombEntityMeta`, `readCombMeta`, `readCombQueryMeta`, `readCursor`, `resolveTranslation`, `runCli`, `shardMap`, `sqliteErrorHandler`, `updateCircuitBreaker`, `validateFilter`, `withRetry`.

   `CliIo` holds `cwd`, `out`, `err`, `run` and `confirm` alone. 0.20's `readPgObjects`, `replayPgHistory`, `readyPgDev` and `locatePeer`, seams comb's own tests fake and typed by its internals, are gone from it, and `runCli` reads none of them from an io that carries one. `Run`, `RunOptions`, `RunResult` and `BinPeer`, which type `run`, are exported from `@lovrozagar/comb/cli` as from `/migrate`. **Fix:** drop such a field from the io you pass; comb finds its peers, reads Postgres and readies the dev database itself. Every type a public declaration names is now one you can import, from the subpath whose function or type names it, or from the one subpath that owns a type several share (the column options from `/sqlite/constraints`, `CombError` and the constraint map from the root, the list query types from `/query`), so a helper typed around comb's API names what it takes and returns; a test holds each subpath to its list, and the few kept internal to theirs, each with its reason. `ListQuerySchema`, `RetrieveQuerySchema`, `paginateMerged`, `createListQuerySchema`, `createRetrieveQuerySchema` and `queryHelpers` changed only in the names their declarations give types they reach: `ListQueryRequest`, `RetrieveRequest` and `PaginationResponse`, exported under those names. `@lovrozagar/comb/query` exports the functions `queryHelpers` groups, `paginate`, `drizzleListOptions`, `drizzleProject`, `extractFilterValue` and `extractFilterValues`, so a project that emits declarations can export `queryHelpers`, or a helper returning what one of them returns, where 0.20 failed it with TS2742, its type naming a file only comb's `types/` folder holds. `processIo` and `runCli` change with `CliIo`. The options of `run`, which `DrizzleExportOptions`, `SchemaDiffOptions`, `checkAtlasInstalled`, `createD1Provider`, `createProvider`, `exportDrizzleSchema`, `generateSchemaDiff` and `getAtlasVersion` take, gain an optional `peer`, the `BinPeer` a command runs (step 2).

   `Run` returns a promise, and so do `run`, `checkAtlasInstalled`, `getAtlasVersion` and codegen's `analyze`: comb runs every process it starts (Atlas, wrangler, drizzle-kit, the tables loader) asynchronously, so a SIGINT or SIGTERM to comb reaches it while that process runs (step 56). A `Run` you pass to `runCli` returns a promise too. **Fix:** `await` each call, and make a runner you pass `async`; it answers the same `RunResult` as before.

   `CombError`, which `classifyD1Error`, `classifyPgError`, `classifySqliteError` and `constraintError` return, gains `toJSON()`, the body a client gets: `column`, `errorKey`, `status`, `statusKey` and `table`, the two optional ones left out when unset. Its fields are defined, not assigned, so a project on Bun whose tsconfig sets `useDefineForClassFields: false`, as legacy decorators need, keeps `column` in the JSON body and in a spread; 0.20 dropped it there, into JavaScriptCore's own `Error.column`.

   A declared `pattern` holding `\d`, `\w`, `\s` or `\b`, or a capital of one, is refused at codegen, naming the column and the class to write out (`[0-9]` for `\d`, `[A-Za-z0-9_]` for `\w`): ECMAScript, Go's RE2 and Rust's `regex` read those escapes as other sets (RE2's `\s` is ASCII, Rust's `\d` and `\w` are Unicode), so one published pattern meant three rules. `patterns.E164_PHONE` writes its digits as `[0-9]` for the same reason, so it stays a pattern codegen takes. comb's own patterns write their classes out too: an id's refuses each ECMAScript blank by name, and a plain `date`, `timestamp` or `time` column publishes comb's ISO pattern, zod's own with each `\d` as `[0-9]`.

   A declared `pattern` holding `.` outside a class is refused at codegen as well, naming `[^\n\r]`: ECMAScript's `.` refuses `\r`, U+2028 and U+2029, which RE2's and Rust's take. So is one holding a lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`) or a backreference (`\1` to `\9`, `\k<name>`), which neither engine compiles, so a Go or Rust validator refused the whole document of any API with that field, and so is one holding `\0`, an octal escape Rust's regex refuses. Write the class meant, the rule without the lookaround or backreference, and NUL as `\x00`, which every engine reads as NUL.

   `ManifestColumn` gains `sqlType`, the column's SQL type with its modifier as drizzle writes it (`timestamp(3) with time zone`, `interval day`, `numeric(3, -2)`): a plain Postgres column's rule reads the modifier, so `kind` alone (`PgTimestampString`) did not tell a `timestamp` from a `timestamptz(3)`. The field is additive, so the manifest's `v` stays 3.

   `parseOrder()` returns `null`, and the list query schema answers a 400 naming the entry, for an `order` entry with whitespace around it (`title.asc, created_at.desc`, a tab, an `order` of spaces alone) or a field named twice (`title.asc,title.desc`), which 0.20 trimmed or let the last entry win in `sortOrderBy` while `parsedSort` kept both (step 33).

   `classifyMigration`, `parseMigration` and `extractDropStatements` take `kind`, the `TargetKind` a file applies to (`"d1"`, `"local"` or `"sqld"`, step 3), in place of 0.20's `d1: true`. A call passing `{ d1: true }` fails to compile (TS2353), as does a variable holding only `d1` (TS2559); one whose options object also sets another field compiles, and throws a TypeError naming `d1` when it runs, as any option these functions do not take does, in JavaScript too. **Fix:** pass `kind: "d1"` where you passed `d1: true`, and drop `d1: false`.

   Every optional property comb declares takes `undefined`, as comb reads a key set to `undefined` as the key left out: a project under `exactOptionalPropertyTypes` can forward a value that may be unset, `createUlidFactory({ now: env.NOW })` or `createListQuerySchema({ pagination: { maxLimit: env.MAX } })`, where 0.20 refused it with TS2379 or TS2375. `c.enum` reads a state set to `undefined` the same way: `{ initial: undefined }` records no state machine, where 0.20 recorded one that named no state.

   `ListExtra` and `ListExtras` gain `_combKeyTexts`, and `DrizzleListOptions`'s `extras` returns it on a sorted list; `createCursor` takes `asRead`, the sort fields its list binds as read. `ListQueryConfig`'s `limits` and `validateFilter`'s third argument take `undefined` for any key (step 11).

   `tiebreak` is a reserved list key, as the parsed output carries it: `createListQuerySchema` throws on an `extend` shape holding a field named `tiebreak`, which 0.20 took. **Fix:** rename the field.

2. **Install `wrangler` and `drizzle-kit` in the project that runs comb.** comb now finds each in the project, from the working folder up, checks that package's version and runs its own bin by path: `wrangler` on `node`, `drizzle-kit` on the runtime running comb. 0.20 checked the `wrangler` comb's own install resolved and then ran whichever `wrangler` was first on `PATH`, so in a workspace the version comb checked could differ from the one it ran. `PATH` no longer counts: a `wrangler` or `drizzle-kit` installed only globally, or reached only through `node_modules/.bin`, is refused with the range and the install, and a workspace runs the copy it installed itself. `comb migrate diff` runs `drizzle-kit` by its bin path on the runtime running comb, so it needs no Bun under Node: 0.20's `bun drizzle-kit` followed the bin's `node` shebang, and ran it on Node. The `run` you pass `createD1Provider`, `createProvider` for a `d1` config, or `exportDrizzleSchema` sees the same: its command is the runtime (`node`, or the running comb's `process.execPath`) and its arguments start with the bin's absolute path, as in `node ["<project>/node_modules/wrangler/bin/wrangler.js", "d1", "execute", …]`, where 0.20 gave `wrangler ["d1", "execute", …]` and `bun ["drizzle-kit", "export", …]`; under Bun, `drizzle-kit`'s options also carry `BUN_BE_BUN=1` in `env`, so an app compiled to one executable runs Bun on the bin rather than itself. Codegen's `analyze` and every D1 command but `migrate diff` (`status`, `check`, `apply` and `baseline`) are refused in such an executable, each with the reason: codegen and D1's check run a child process, which cannot read the modules the executable embeds, and the D1 commands load `wrangler`'s module from the project, which the executable cannot, so run them with bun or node. `createD1Provider` and `createProvider` for a `d1` config find `wrangler` from `process.cwd()` and `exportDrizzleSchema` finds `drizzle-kit` from its `cwd`, each refused before your `run` is called when that project lacks it.

3. **On libsql over a network and on Turso, take out what the server refuses.** A libsql URL of any scheme but `file:` and `:memory:`, and every Turso database, reach a libsql server (sqld), which refuses at parse every pragma outside its list, a pragma with a quoted name, `ANALYZE`, `ATTACH`, a `TEMP` object and `load_extension()`. 0.20 passed them at check and apply then failed on them; 0.21 refuses them at check with no override, naming "libsql server (sqld)". **Fix:** remove the statement from the file; for a connection pragma 0.20's step 3 told you to add, the server runs the file without it. Such a target's files now apply through the run's one client.

4. **Read bcrypt's limit on `passwordText` as `x-comb-maxUtf8Bytes`.** `passwordText({ hash: "bcrypt" })` and `passwordText.typed({ hash: "bcrypt" })` publish `x-comb-maxUtf8Bytes: 72`, the UTF-8 bytes of the string itself, where 0.20 published `x-comb-maxBytes: 72`, which meta-contract §2.1 defines as the bytes of a value's JSON text, quotes and escapes included: a reader applying it as defined refused every 71- or 72-byte password comb took. Both forms publish `x-comb-transform: ["nfc"]`, so a reader normalizes before it counts, as comb does: 0.20's `minLength` and `maxLength` read without it refused a long password typed decomposed and took a short one. A password out of bounds is now zod's `too_small` or `too_big` issue with its `minimum` or `maximum`, bcrypt's bytes a `too_big` with `maximum: 72`, where 0.20 gave a `custom` issue with neither. `passwordText({ hash: "bcrypt", min })` with a `min` past 72 throws a TypeError at build, as no password passes it. **Fix:** a client that reads `x-comb-maxBytes` from a password schema reads `x-comb-maxUtf8Bytes` and applies the `nfc` transform first; error handling that matched the `custom` messages matches `too_small` and `too_big`.

5. **Set a tenant column once.** A column declared `{ tenant: true }` is out of the generated update DTO and listed `immutable`, in the stamp and the manifest, whatever it references: 0.20 kept only a tenant that was a non-`mutable` reference out of update, so a `c.text` or `c.integer` tenant, or a `c.ref` to a table in another database, took a body that moved the row to another tenant, while `tenantColumn` named it. `{ tenant: true, mutable: true }` fails codegen, naming the column. **Fix:** regenerate; move a row between tenants with a statement of your own, not a PATCH body; drop `mutable` from a tenant column.

6. **Send a Postgres value its type modifier keeps.** A plain drizzle column's write DTO reads its modifier as Postgres does: a `time(p) with time zone` takes an offset (0.20 refused every value and took a local time); a precision refuses a longer fraction of a second on a time, timestamp or interval, which Postgres rounds, `timestamp(0)` taking `23:59:59.6` into the next day; an interval with fields refuses a part below the last (`PT1H` into `interval day`, `P1Y2M3D` into `interval year to month`), which Postgres drops without an error; a `numeric(p, s)` with `s > p` takes its values (0.20 refused all of them) and one with `s < 0` takes only a whole number ending in `-s` zeros below `10^(p - s)` (0.20 took `123456`, a 22003, and `99949`, stored as `99900`). **Fix:** regenerate; send each value at its column's precision and fields.

7. **Run Atlas >=1.2.0 <2.** comb now reads `atlas version` before a command's first I/O and refuses an Atlas outside that range, or missing from `PATH`, naming it with its install page, in the same refusal as any npm peer the command lacks; 0.20 failed later with `atlas migrate hash failed: atlas: command not found`. `comb migrate status` on Postgres needs Atlas as the other commands do. A SQLite `comb migrate diff` whose comb.config.ts declares FTS now names `ts-morph` with `drizzle-kit` before any process. comb no longer sets `PGSERVICEFILE` for Atlas, which before v1.2.0 failed every Postgres command on it.

8. **Drop the type argument from `getHandle`.** `ShardRouter.getHandle(mapping, env)` now types the shard's handle by the env it is passed: the type the env's `SHARD_DB_*` bindings have, which `wrangler types` writes as `D1Database`, so the handle goes to `drizzle()` as it is. A binding bound in only some of the config's environments, which `wrangler types` writes optional (`SHARD_DB_1?: D1Database`), is taken too, and `getHandle` throws `Missing D1 binding` for one absent at run time. An env typed by a string index signature gives the binding its index holds, `Record<string, D1Database>` a `D1Database`, and the structural `D1DatabaseLike` when it holds none; an env whose known keys hold no `SHARD_DB_*` binding fails to compile. A helper generic over the env, `<E extends Env>(env: E)`, gets the binding its bound's `SHARD_DB_0` holds when that key is required, and one bounded by no `SHARD_DB_*` key, `object` and `{}` among them, fails to compile. `wrangler types` writes `SHARD_DB_0?: D1Database` when no shard is bound at the top level, and a helper bounded by that `Env` fails to compile (TS2769) until it widens the env first: `const env: Env = given; router.getHandle(mapping, env)` gives a `D1Database`. 0.20's `getHandle<D1Database>(mapping, env)` now fails to compile (TS2345), and an `Env` interface that 0.20 refused (TS2345) is taken. **Fix:** call `getHandle(mapping, env)` with the Worker's `env`. `ShardBindingOf<Env>` names the handle's type, and `ShardEnv<Env>` what the env must hold.

9. **State the database's dialect in the drizzle config a diff reads.** `comb migrate diff` now imports the drizzle config before drizzle-kit runs and refuses one whose `dialect` is not the database's (`postgresql` for Postgres; `sqlite` or `turso` for SQLite, libsql, Turso and D1), or that states none, naming the file, its dialect and the database's. 0.20 ran `drizzle-kit export` with the config's dialect, which exports none of the other dialect's tables, so the diff wrote a `DROP TABLE` for each and exited 0. `comb migrate init --dialect` likewise refuses a `drizzle.config.ts` already there whose `dialect` is the other one, where 0.20 kept it silently. **Fix:** set `dialect` in each drizzle config, or point the database's `drizzleConfigPath` in comb.migrate.config.ts at one of its dialect.

10. **Name the database on every `comb migrate diff`.** Each command now requires the positionals its usage line marks `<…>`, as it already refused more than its `[…]` parts allow, so `comb migrate diff` with no database is refused with `Usage: comb migrate diff <database> [name]`. 0.20 took a bare diff as a project with no comb.migrate.config.ts: it diffed into a new `./atlas-migrations` against no history, writing the whole schema again beside the database's real migrations and skipping comb.config.ts's FTS, while `status` showed nothing pending. **Fix:** run `comb migrate diff <database>`. Without a comb.migrate.config.ts, the name is the comb.config.ts database whose FTS the diff writes, and the migrations stay in `./atlas-migrations`.

11. **Pass `-e` to a diff whose environments differ in what it reads.** `comb migrate diff` now takes `-e`/`--env`. Without it, a diff reads the database's environments, each falling back to the database's own provider as `apply -e` does, when they agree on what a diff reads: whether the database is D1 and, on Postgres, `devUrl` and `schema`. Environments that differ in one are refused, naming them. 0.20 refused `-e` on diff and read the first environment, so the key order in comb.migrate.config.ts chose the `devUrl` and `schema` it diffed on. **Fix:** pass `-e <environment>` to such a diff. Environments that agree, as several D1 environments of one database do, need nothing.

12. **Type-check with TypeScript 5.7 or later.** comb's declarations use `NoInfer` and `Uint8Array<ArrayBuffer>`, which a compiler older than 5.7 cannot read. With `skipLibCheck` on, as starter templates set it, 0.20 compiled on such a compiler with no error and dropped the checks the two types carry, so a misspelled `defineStateMachine` transition and a `createUlidFactory` `random` that takes a string compiled. comb now states `typescript >=5.7.2` as an optional peer, which npm refuses below its range (`ERESOLVE`), and an older compiler reads no declarations from any subpath of comb: each import fails with TS2306, naming comb's `types/typescript-floor-types.d.ts` as "not a module", in the project's own file. **Fix:** upgrade `typescript` to 5.7.2 or later.

13. **On D1, take out what D1's engine refuses.** Check now runs each pending file on D1's own engine, the checked wrangler's local D1, as wrangler sends it, and compiles the views, triggers and generated columns it made or changed. A file 0.20 passed and wrangler then failed, or applied and then broke every write to a table or read of a view (a function outside workerd's allowlist, such as `power()` or `median()`, a TEMP object, a savepoint, a limit), is refused at check, naming D1's error. A file holding `BEGIN TRANSACTION` in a literal or a comment is refused too, as wrangler `--local` cuts it from the text. **Fix:** remove what D1 refuses, and split the words of such a literal, as in `'BEGIN ' || 'TRANSACTION'`. `PRAGMA optimize` with a mask, which 0.20 refused, now passes, as D1 runs it.

14. **On SQLite, check each database that has a trigger naming `begin` or `end`.** comb now splits a file where SQLite ends a statement. 0.20 counted every `begin`, `case` and `end` word in a trigger, so a trigger that names a `begin` column or table (`new.begin`, `ON begin`) took the statements after it into its own, which libsql ran without them while apply said `Done` and recorded the file; and an `end` in the body (`SET end = 1`) cut the trigger, so its file never applied. **Fix:** run `comb migrate status <db>` and compare each applied file after such a trigger with the database (its columns, indexes and backfilled rows); apply what is missing in a new file. A file that never applied now applies.

15. **On SQLite, libsql and D1, apply a file holding a no-break or other Unicode space with 0.21.** A migration's hash now keeps every space SQLite reads as part of a name, all but space, tab, newline, form feed and return: `a b` is a column `a` of type `b`, while `a`, a no-break space and `b` is one column of that name. 0.20 folded both to one space, so a file applied as one and then edited to the other matched its recorded hash and was never named as edited. A file recorded before 2026-11-03 19:00 UTC still matches the hash 0.20 recorded for it; a 0.20 record from that time on matches only the hash 0.21 takes. **Fix:** none for a file 0.20 applied before then. Apply a file holding such a space with 0.21 from now on: one 0.20 applies after then is named as edited ("was applied, then edited").

16. **On libsql and Turso, take out what libsql's SQLite refuses.** Check now proves a libsql or Turso database's pending files on libsql's own SQLite, the one they apply on, and the proof's error names it ("comb could not run this in the proof copy on libsql's SQLite 3.45.1: …"). 0.20 proved them on the runtime's newer SQLite, so a file using what libsql's lacks, a digit separator such as `1_000` or `if()`, passed check and failed at apply, and a file making a vector index (`libsql_vector_idx`) was unsafe because the copy could not run it. A vector index is now proven like any other index, and `baseline` compares it by name and definition, replayed on libsql's SQLite. **Fix:** rewrite a pending file check now refuses in the syntax libsql's SQLite runs.

17. **Merge only a SQLite list.** `buildDerivedListQuery` with `merged` on a Postgres list, and `buildListQuery` with `merged` over a Postgres table, are a `TypeError` at build: `paginateMerged` compares as SQLite does, and a Postgres server orders numeric text and collated text its own way, so 0.20.1 could serve such a list out of order. **Fix:** page a Postgres list on its server, without `merged`.

18. **Select `_combKeyTexts` in a hand-rendered select.** An anchored derived list sorted by a joined table's column, and a derived list with no `anchor`, read each key as the row returned it: a joined Postgres `timestamp(6)` resumed at its millisecond, and a joined SQLite seconds-mode key or a REAL ±Infinity resumed from the value the driver read, so pages repeated or skipped rows. Such a list selects `_combKeyTypes` for the joined key and `_combKeyTexts` for a time key. A merged list sorted by a seconds-mode timestamp selects `_combKeyTexts` too, and merges by the seconds each row stored: it compared the rows' Dates, so a fraction below the millisecond was served in id order, or a 500 blamed the collation. `db.select({ ...columns, ...built.extras })` and `applyListQuery` select them; a select that renders each extra by hand must render the new one too, or the page is a 500 `page_not_wired`.

19. **Select `_combKeyTexts` on a list sorted by a `numeric` read as a number.** drizzle's `numeric({ mode: "number" })` reads a value as the nearest double, so a cursor resumed from it re-served one row forever ascending and skipped rows descending, on every list. Each list now selects the key's text as `_combKeyTexts`, and `listOptions` returns it among `extras` whenever the request sorts, on SQLite too, where it is empty. An expression key carries its text only where its type is a `numeric` or a domain over one; an enum, a domain over text and every other type are read exactly and carry none. `findMany({ extras: options.extras })`, `db.select({ ...columns, ...built.extras })` and `applyListQuery` select it; a select that names the extras one by one must name it, or the page is a 500 `page_not_wired`. A key bound as read (a derived list's, or an anchored list's joined key) whose number under any other type no double names is past a safe integer or a fraction is a 500 `sort_not_wired` where it paged wrong.

20. **Expect `likeSearch` on a raw column to fold ASCII case again.** `likeSearch(post.title)` on a column `searchText` didn't write found no title holding a capital since 0.14: it compared the folded term with the raw text, so `Hello` missed `Hello World` and `postgres` missed `Postgres Tips`. It now matches the expression's `lower()`, as 0.13's LIKE did; a `_search` column matches as before. Accents still match only in a `_search` column. **Fix:** none; to match accents, search a column `searchText` wrote.

21. **Read a filter limit set to `undefined` as its default.** `validateFilter(filter, fields, { maxConditions: undefined })` turned that cap off, so a filter could bind past D1's 100 parameters, and `createListQuerySchema({ limits: { maxSortKeys: undefined } })` threw. Both now keep the default for a key set to `undefined`, and `validateFilter` throws a `TypeError` for a limit that is `NaN`, negative, fractional or past a safe integer, as `createListQuerySchema` did. **Fix:** a `validateFilter` call that passed such a number passes a whole number from 0.

22. **Give `c.json` the schema of the stored document.** Codegen refuses a `c.json` schema holding a transform, a pipe or a preprocess, naming the column: the write DTOs store the schema's output and the read DTO parses the stored row with the same schema, so 0.20 took the body, stored its output, and then refused every read of that row. Move the transform to the request body's schema. An overwrite (`.trim()`, `.toLowerCase()`), a default and a coerce stay, as their output parses again. Codegen also refuses a NOT NULL `c.json` column whose schema takes null, which 0.20 let the create DTO take and the insert fail: make the column nullable, or pass the schema's non-null form. It refuses one whose schema takes undefined (an `.optional()` document) where no default fills the column, as a create that leaves it out sends no value and the insert fails: drop `.optional()`, or give the column a default.

23. **Create a state column's row at its `initial`.** A `c.enum` column whose machine declares `initial` takes that value alone in the generated create DTO, published as `const` and as its example; the update DTO keeps every value. 0.20 took any state on create, so a body created a job already `done` and skipped the lifecycle `assertTransition` guards. Codegen refuses such a column's default when it is another value, or a default function, an update function or SQL, which comb cannot hold to `initial`: write `.default(initial)`, or drop `initial` where rows start in several states.

24. **Read an identity column as generated, and a private column's flags as the bodies'.** One rule now decides which write bodies take a column, and the DTOs, the stamp and the manifest all read it. A non-key identity column (`generatedAlwaysAsIdentity()`, `generatedByDefaultAsIdentity()`), which 0.20 already left out of both bodies, is now in the stamp's `generated`, and the manifest flags it `generated` and `immutable`, where 0.20 flagged it neither while the stamp called it immutable. A private column's manifest flags state what the bodies do: a private reference is `immutable`, a private `autogenerate` column `generated` and `immutable`, where 0.20 flagged every private column `false`. `isExcludedFromUpdate` from `@lovrozagar/comb/codegen` counts an identity column, and `deriveEntityMeta` takes the table alone: its second argument, the update body's emitted fields, is gone, as the rule it read is the one the generator applies. The stamp's `generated` lists its fields in the table's order, the key no longer moved first.

25. **Run zod 4.6.0 or later.** comb's zod peer range is `>=4.6.0 <5`, raised from `>=4.5.4 <5`: zod 4.5.x publishes an email pattern with lookahead, which Go's RE2 and Rust's `regex` crate refuse, so a Go validator refused the whole document of any API with an email field.

26. **Write a declared `pattern` for `u`.** Codegen compiles a constraint's `pattern` under `u`, the mode JSON Schema reads it in, and emits it with `u` whether the tables file wrote it or not, so zod runs the rule the published document states. Without `u`, 0.20 ran another one: `\p{L}` was a literal `p{L}`, and `.` and `[^x]` matched one UTF-16 unit, so `/^[^x]{2}$/` took one emoji and refused two. A source that does not compile under `u`, such as `\-` outside a class, is refused at codegen with the engine's reason, naming the column. comb's own patterns run under `u` too: an id under the id rule is now 48 code points at most, where 0.20 counted UTF-16 units and refused 25 emoji that its published schema took. A `macaddr` or `macaddr8` pattern publishes its hex digits in either case, where 0.20 published a lowercase-only rule beside a case-insensitive zod regex; and an `interval` publishes comb's own ISO 8601 duration pattern, which takes what `z.iso.duration()` takes with no lookaround, and no `format: "duration"`, whose RFC 3339 grammar takes no fraction of a second, so a reader that checks formats refused `PT1.5S`, which the DTO and Postgres take. **Fix:** regenerate; check each declared pattern against the values it must take, and escape a character outside a class only when it is a syntax character.

27. **Read a manifest relation's `table` as an entity name.** The manifest is `v` 3: a relation's `table` is the target entity's `name`, schema-qualified on Postgres (`app.org`), where `v` 2 wrote the variable the target was declared under (`org`, `userAccount`), which matched no entity's `name` when the two differed. `column` and `refColumn` name columns among each entity's `columns`, as before. **Fix:** a reader that joined a relation through `varName` joins through `name`, and accepts `v` 3.

28. **Expect check to adopt a role a `DO` block makes, on Postgres.** A role a history file adds inside a `DO` block, a function, `EXECUTE` or `CALL` is the replay's own on a `postgres://` `devUrl`: check and baseline make it `NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS` with no password, drop it after the replay, and pass the file, and check prints `Check adopted role <name>, which <file> made …` for each. A change the same file makes to that role, such as a `GRANT` to it, an `ALTER ROLE … SET` or a password, is the replay's own too. 0.20 refused such a file, so the usual `DO $$ BEGIN IF NOT EXISTS (…) THEN CREATE ROLE app; END IF; END $$` failed check, and 0.20's step 4 had it rewritten as a plain `CREATE ROLE`. A change to a role the server already holds stays refused. On a superuser's devUrl a password change reads as `role <name> changed (rolpassword)` where 0.20 named `pg_authid` alone. **Fix:** none; a `DO` block 0.20 had you rewrite may stay as it was.

29. **Read four more write rules from the document.** A Postgres `bigint` in string mode publishes its range as its pattern, at most 18 significant digits or 19 not past `9223372036854775807` (`…808` when negative), where 0.20 published `^-?\d+$` and held the range in a refine. A `real` publishes `not: { minimum, maximum, not: { const: 0 } }` at 2^-150, refusing a nonzero value at or below it in magnitude, which real would round to zero. A `cidr` publishes `x-comb-cidr: true`, and a multidimensional array `x-comb-rectangular: true`, both new in meta-contract §2.1. A written plain `json`, `jsonb` or SQLite json-mode field publishes its recursive value once in `$defs`, where 0.20 published two identical definitions. **Fix:** regenerate; a reader that refuses an unknown `x-comb-*` key learns the two new ones.

30. **Page a Postgres `double precision` key holding ±Infinity with either builder.** `buildDerivedListQuery` on a Postgres list, anchored or not, and `buildListQuery` over a Postgres table bound a cursor's values as SQLite reads them, writing ±Infinity as `9e999`, which Postgres reads as a numeric past every double: the page after a row holding ±Infinity was a 500. Each builder now binds by its list's dialect, `buildListQuery` reading it from its table, as `listOptions` did. **Fix:** none.

31. **Page a blob key, and get a 500 for a key no cursor carries.** A list sorted by a buffer-mode BLOB column minted a cursor the next page refused as `invalid_cursor`, a 400, as the codec wrote the bytes as a JSON object its reader refuses; the cursor now carries them under a `$bytes` tag, so `CursorValue` and `DecodedCursor` hold a `Uint8Array` and `readCursor` returns one. A sort value or id the cursor would not read back as itself, a JSON object, an array, a function or an integer past 20 digits, is now `sort_not_wired`, a 500 naming the field, on the page that reads it, where 0.20 minted a cursor the next page refused. `createCursor` now refuses a row without a sort field or its id, as `paginate` did, and both name the fields in `the next cursor is minted from each row's …`. A cursor under a computed sort (`@relevance`) is now refused at the mint as `cursor_pagination_unsupported` (400), the refusal `buildListQuery` gives a cursor under one, whatever the row holds. A list sorted by a drizzle `customType` column (a citext, a domain, an app type) pages too, where 0.20 refused its cursor on page 2 as `invalid_cursor`: the cursor carries the value its `fromDriver` read and binds it back through its `toDriver`, and on Postgres a custom column that is a `numeric`, or a domain over one, carries its text, as an expression over one does, so a mapper that reads it as a JS number pages it exactly. **Fix:** sort by a column of text, numbers, booleans, times or bytes; a reader of `DecodedCursor` values handles a `Uint8Array`.

32. **Set pagination limits the schema can serve.** `createListQuerySchema` took any `pagination.maxLimit` and `defaultLimit`, and zod's `.default()` skips the limit's own check, so `{ maxLimit: 10 }` alone answered every request without a `limit` with `invalid_page`, a 400, as the default 20 passed the maximum; a `maxLimit` of 0 or 1.5 also made `readCombQueryMeta` drop the route's query facts. Building the schema now throws a `TypeError` naming the key unless `maxLimit` is a whole number from 1 and `defaultLimit` one from 1 to `maxLimit`. **Fix:** with a `maxLimit` below 20, set `defaultLimit` at or under it.

33. **Send a well-formed `order`.** The list query schema dropped an `order` entry that was empty or named no field, so `order=asc` was a 200 sorted by the default, descending, while the published pattern refused it. Each such entry (`asc`, `desc`, `.desc`, `,`, `title.asc,`) is now an issue on `order` naming it, and `parseOrder()` returns `null` for it, as `parseFilter()` does for a malformed filter. So is an entry with whitespace around it, which the pattern refuses too, and a field named twice, which sorted by its first entry while `sortOrderBy` reported its last. `limits.maxSortKeys` of 0, which no order could meet while the pattern admitted one key, is a `TypeError` at build. **Fix:** a client sending a bare direction or a trailing comma drops it; a caller of `parseOrder()` handles `null`; set `maxSortKeys` to 1 or more.

34. **Read a filter value only where the filter holds rows to it.** `queryHelpers.filterValue` and `filterValues` returned a condition's value whatever its operator, so `project_id.ne.p1` read as `p1`, and took the first of two conditions on a field. They now take an operator, `eq` by default, read only top-level AND conditions, and return `undefined` for a field named more than once. **Fix:** pass the operator for a value read under another one, such as `in`.

35. **Write `-- atlas:txmode none` in lowercase, once, in a header a blank line closes, on Postgres.** comb now reads a file's header as Atlas does: a comment line before or after the directive, a blank line holding spaces and CRLF line ends keep it, and a tab after `--` or no blank line drops it, as Atlas runs the file in one transaction. 0.20 read only directive lines, so it refused a `CREATE INDEX CONCURRENTLY` under a header with a comment line that Atlas ran outside a transaction, and passed a file whose header Atlas refuses before it runs a statement. Check now refuses that header, quoting Atlas: `-- atlas:txmode NONE`, any value but `none` or `file`, `all`, or two txmode lines. `check` and `apply` also refuse, on every dialect, a file whose opening `atlas:` line no blank line follows, naming the file and the line, where 0.20 passed it and Atlas ran it in one transaction. **Fix:** write the one txmode line Atlas reads, and a blank line after the header.

36. **Read `limit`, `select` and `order` examples as the endpoint's own; take a cursor from a page.** A list or retrieve schema's `limit` text and examples are its own `defaultLimit` and `maxLimit`, `select`'s are its first scalars, a relation with one of the fields it declares, and `*`, and `order` gives a second key only where `maxSortKeys` takes two. 0.20 published the same ones on every endpoint: `limit` 20 and 50 with "Defaults to 20", `select` `id,name,email` and `id,author(name,posts(title))`, which nests a relation the grammar refuses, and one fixed cursor, an `invalid_cursor` on any list since a cursor opens only under the app's secret and the list's scope. A docs page or contract tester that sent them got a 400 from a correct server. `cursor` now publishes no example, and a test parses every example a query schema publishes through that schema. `CURSOR_EXAMPLES`, `LIMIT_DESCRIPTION`, `LIMIT_EXAMPLES` and `SELECT_EXAMPLES` are gone. **Fix:** read the examples from the schema, or call `limitParamMeta(defaultLimit, maxLimit)` and `selectParamMeta(fields)`; send a cursor taken from a first page's `nextCursor`.

37. **Rely on an `LruCache` hard TTL alone.** A cache built with `hardTtlMs` and no `ttlMs` had `get()` return an entry and `has()` say true long past its hard TTL, while `getWithMeta()` evicted it. Every read now checks the hard expiry first, and a missing soft TTL means fresh until the hard one. **Fix:** none.

38. **Read an integer bound past a JS number's exact range as that range.** A `c.integer` on SQLite, or a `c.timestamp` on either dialect, declared with a `max` above 2^53 − 1 or a `min` below −(2^53 − 1) is clamped to the range the column holds, as a smaller bound past int4 already was on Postgres: the manifest's `min` and `max`, the generated chain and the published schema all state ±9007199254740991. 0.20 stated the declared bound, `max 1e20`, in the manifest and the chain, while the DTO, through `.int()`, refused anything past the range, so a reader validating with the manifest took values the server refused. **Fix:** none in the app; a reader of the manifest gets the bound the server enforces.

39. **Key a hand-written constraint map as codegen does.** README's example keyed a unique and a foreign key by constraint name, which only the Postgres handler matches; on libsql, bun:sqlite and D1 both entries went unused, and the violation got the generic `unique_constraint_violation` or `foreign_key_violation`. The example now keys a unique by its columns and a foreign key by its first column, as codegen writes them, and states each kind's key. On SQLite and D1, a map's lone `foreignKey` entry is now blamed only for an INSERT whose column list sets that column, or an UPDATE that assigns it: an INSERT that sets no such column, or a map key that names no column, is the generic `foreign_key_violation` with no `column`, where 0.20 blamed the entry and sent its key as `column`. **Fix:** a hand-written map copied from the old example keys its `unique` and `foreignKey` entries by column SQL name, and lists every foreign key of the table.

40. **Publish a derived list's tiebreak.** The list schema published `stableTiebreak: "id"` whatever column the list broke ties on, so a derived list keyed by `_id` told a page walker the wrong column. `createListQuerySchema` takes `tiebreak` and publishes it, `id` by default. The parsed output carries the tiebreak, and `buildDerivedListQuery` refuses an `idColumn` of another name with a `TypeError` naming both, so the published column is the one the list breaks ties on. **Fix:** a derived list whose `idColumn` is not `id` sets `tiebreak` to its name; regenerate a manifest that reads it.

41. **Read `sort_not_wired` from `listOptions` as from `buildListQuery`.** `queryHelpers.listOptions` answered a sort on no column of the queried table with `cursor_pagination_unsupported`, on a page with no cursor, and only once drizzle called its `orderBy`. Such a sort is now `sort_not_wired` (500), as `buildListQuery` answers it, and a computed sort (`@pop`), which the relational API cannot order by, is refused when `listOptions` is called. A table with no `id` column, which `listOptions` breaks ties on, keeps `cursor_pagination_unsupported` (500), now with its own cause, ``listOptions breaks ties on the table's `id` column, which this table lacks``, rather than one blaming a sort on `id`. **Fix:** an error handler keyed on the old key for a sort on no column reads `sort_not_wired`; one for a table with no `id` is unchanged.

42. **Give each `c` helper only the keys its type takes.** Codegen refuses a constraint key the helper's own constraint type does not name, naming the helper and the key: `c.integer takes no email`, `c.timestamp takes no pattern`, `c.text takes no maxBytes`, `c.json takes no trim`. TypeScript already refused these, so only a tables module in JavaScript or one with a cast meets it. 0.20 took any key one helper or another took and dropped its rule without a word: a `c.integer` given `email: true` published `user@example.com` as its example, which its own field refused, and the manifest called it an email; a `c.timestamp` given a `pattern` lost it. `fieldConstraintsOf` takes `helper`, the `CombColumnKind` that built the column, or `null` for a drizzle column, which takes no key. **Fix:** drop the key the helper does not take, or move the column to the helper whose type takes it; a direct caller of `fieldConstraintsOf` passes `helper`.

43. **Filter by a number a double holds.** A filter number too small for a double, such as `n.lt.1e-400`, read as 0, so `lt` missed the rows holding 0 and `eq` matched them; overflow (`1e999`) was already refused. Nonzero digits that read as 0 or a subnormal, below 2^-1022 in magnitude, are now a 400 naming the value. **Fix:** none.

44. **Send a `timetz` offset as `Z` or `±hh:mm`.** A plain Postgres `time with time zone` column's write DTO takes the offset RFC 3339 writes, `10:00:00+02:00` or `10:00:00Z`, as its `timestamptz` beside it already did; `10:00+02`, `10:00+0200` and `10:00-0530`, which Postgres also takes, are a 400. 0.20 took them on a `timetz` alone, so the two offset rules disagreed and a client that kept to one spelling for both was refused on the other. **Fix:** write the offset with its colon and minutes, `+02:00`.

45. **Match every row with an empty `nin.()` on a seconds column.** On an integer `timestamp` (seconds) column, `nin.()` lowered to `IS NOT NULL` and dropped the rows holding none, where on every other column and through `buildFilterSQL` it matched every row, as this README says. It now matches every row there too. **Fix:** none.

46. **Pass a `CombError` its cause as a string.** `cause` is the message a client may see, yet it took `unknown`, and this README's own example passed the original error there, whose text holds the SQL and its bound values. `cause` is now `string`, on the constructor and on the error, and the original goes on `source`, which is never serialized. Every comb classifier already passed strings. **Fix:** move an error object passed as `cause` to `source`, and give `cause` the message the client should read.

47. **Keep the cache when `LruCache.set` refuses a TTL.** A `set` given a TTL it refuses, such as `0` or `NaN`, threw its `RangeError` only after it had dropped the key's current entry and, on a full cache, evicted the oldest. It now throws first and leaves the cache as it was. **Fix:** none.

48. **Give `createUlidFactory` any clock that reads milliseconds.** A clock with a fraction, such as `performance.timeOrigin + performance.now()`, wrote the text `undefined` into every id, 34 characters outside the ULID alphabet, and a clock past 2^48 − 1 wrapped, so its ids stopped sorting. The reading is now floored to its millisecond, and one that is not finite, is negative or is past 2^48 − 1 is a `RangeError` naming it. **Fix:** none; a clock that read outside that range now throws.

49. **Read one `table` for a `pgSchema` table on Postgres.** A delete of a row a child still references named its table bare (`org`), where every other violation of it named the key the constraint maps give it (`app.org`), so a client keyed by `CombError.table` saw two tables, and a public `org` beside it looked the same. The delete's table is now resolved as every other violation's is. **Fix:** an error handler that matched the bare name on such a delete matches the qualified key.

50. **Move a Postgres file's own `BEGIN`, `COMMIT` or `ROLLBACK` into a `-- atlas:txmode none` file.** Atlas runs a file without that header in one transaction and records it there, so the file's own `COMMIT` ended that transaction: what ran before a later failure stayed while comb reported the file rolled back, and in `check`'s replay a role a later `DO` block made stayed on devUrl's server. 0.20 rated transaction control safe. `check` and `apply` now refuse `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`, `ABORT` and `PREPARE TRANSACTION` in such a file from the file alone, before `check` replays anything; no `-- comb:allow-unsafe:` overrides it. **Fix:** drop the statement and let Atlas's transaction hold the file, or start the file with `-- atlas:txmode none` and a blank line to commit as it goes.

51. **Write a `macaddr8` with two digits an octet.** A plain `macaddr8` column's create and update DTOs refuse an octet of one digit (`8:0:2b:1:2:3`) and two separators in one address, which 0.20 took and Postgres refused with a 22P02, and take the spellings Postgres takes that 0.20 refused: `.` between octets (`08.00.2b.01.02.03`) and `:` or `-` at any gap (`0800:2b01:0203:0405`, `08:002b:01:0203`). A `macaddr` or `macaddr8` with a blank in it, or a `macaddr8` with a separator or a digit after its last octet, is refused, though Postgres takes it.

52. **Write an interval's fraction of a second with `.`.** A plain `interval` column's create and update DTOs refuse ISO 8601's comma for the decimal mark (`PT1,5S`), which 0.20 took and Postgres refused with a 22007; write `PT1.5S`.

53. **Name a plain JSON value `CombJsonValue`.** A plain `json` or `jsonb` column's JSON Schema, in its create, update and read DTOs alike, refers to `#/$defs/CombJsonValue`, where 0.20 published zod's positional `__schema0`, which a recursive `c.json` column added before it renumbered, renaming the type a generated client gives the value. The definition is comb's own `jsonValue` export, one schema whatever the databases, so one document over the DTOs of two databases holds it once. A client that names the old definition names `CombJsonValue`, and an app's own schema that takes any JSON value can use `jsonValue` to share the definition.

54. **Read a plain `date`, `timestamp` or `time` column's issue by its code, format and message.** Its rule is `z.stringFormat("date" | "datetime" | "time", …)` with comb's ISO pattern, where 0.20 wrote `z.iso.date()`, `z.iso.datetime()` and `z.iso.time()`: zod's own publish `\d`, which Rust's `regex` reads as any Unicode digit, and zod's types take no other pattern on them. It takes and refuses the same values, its issue has the same `code`, `format` and `message`, and the JSON Schema is the same, but the issue has no `origin` and no `pattern`. A handler that reads either reads `format`.

55. **Write an IPv6 address as Postgres reads one.** A plain `inet` or `cidr` column's create and update DTOs take an IPv6 address whose IPv4 tail has two or three parts (`::ffff:1.2.3`, which Postgres stores as `::ffff:1.2.3.0`), which 0.20 refused, and refuse a fractional prefix length (`::/1.5`), which 0.20's `inet` took and Postgres refused with a 22P02. Each branch, IPv4 and IPv6, address and network, publishes the pattern it runs, an IPv4 tail included, and no `format`: 0.20 published zod's pattern of hex groups alone, which refused `::ffff:1.2.3.4` though its check took it, beside `format: "ipv6"`, whose grammar refuses a short tail, and `cidrv4` and `cidrv6`, which no format set defines and Ajv's strict mode refuses to compile. A validation issue keeps zod's format name. `isCidr` reads a two- or three-part tail too. Two spellings Postgres takes are refused for the canonical one: a colon before the prefix (`1::f:/64`) and an empty part in the IPv4 tail (`::.255`, `::1..2`).

56. **Expect a stopped apply to end by its signal, and say what it applied.** SIGINT or SIGTERM to comb while Atlas, wrangler or drizzle-kit runs now goes on to that process and, on POSIX, every process it started (workerd, esbuild), and comb waits for it to end before it removes its scratch and ends by the signal (exit 130 or 143). One that is still running 10 s after the signal, a timeout or an output past maxBuffer is killed with SIGKILL, and comb says so; `RunOptions.killAfterMs` sets that grace. On Postgres, an apply stopped so reads Atlas's history once more and prints `Stopped by SIGTERM: applied …; not applied …`, and starts no further file; 0.20 did not pass the signal on: Atlas kept running, and comb stayed until Atlas ended by itself. **Fix:** nothing to change; a script that reads apply's output can read that line, and rerun apply for the files it lists as not applied.

57. **Write a date from year 0001 and an interval's parts within Postgres's range.** A plain `date`, `timestamp` or `timestamptz` column's create and update DTOs refuse year 0000 (`0000-01-01`, `0000-02-29`), which zod's ISO date takes and Postgres refuses with a 22008. A plain `interval` column's take at most 8 digits of years and weeks, 9 of months, days and hours, 11 of minutes and 12 of whole seconds, every value of which Postgres holds alone, where 0.20 took any number and Postgres refused one past its range with a 22015 (`P2147483648D`). A sum of parts past the range (`P99999999Y999999999M`, a 22008) still reaches the database, and `pgErrorHandler` now answers 22015 as it does 22008: a 400 `invalid_value` naming the column.

58. **Read a written email or url by its pattern, not a `format`.** An email field's create and update DTOs publish zod's email pattern, their check, with no `format: "email"`, whose grammar refuses `a@b-.cc`, which the pattern and the DTO take. A url field publishes its https pattern with no `format: "uri"`: its check is the WHATWG URL parser, which takes `https://例え.jp`, `https://ex.co/é` and `https://a/b c`, which RFC 3986's grammar refuses, so a reader that checks formats refused values the server takes and stores. What the DTO takes is unchanged. **Fix:** regenerate; a client that needs a url's RFC 3986 form checks it with the WHATWG parser (`new URL()`) and reads its `href`.

## Upgrading to 0.20.1

What changes for a project on 0.20.0. Before deploying it:

1. **Regenerate for a written JSON field's published shape.** A written `c.json`, `json`, `jsonb` or SQLite `text({ mode: "json" })` field publishes its schema itself, its `x-comb-*` keys on it: a registered schema is `{ "$ref": …, "x-comb-*" }`, and a nullable field is `anyOf: [<schema with its keys>, { type: "null" }]`, the keys on the property too. 0.20.0 published a one-member `anyOf` around the schema, which a generator that does not flatten one types as any JSON: Go and Rust clients typed such a field `json.RawMessage` or `serde_json::Value`, and a generated CLI dropped its flag. What a DTO accepts, its TypeScript type and `.unwrap()`'s keys are unchanged. **Fix:** regenerate.

## Upgrading to 0.20

What changes for a project on 0.19. Before deploying it:

1. **Know what changed in the API.** A test holds these three lists to the exports themselves.

   New exports: `PasswordHash`, `PasswordTextOptions`, `TypedPasswordOptions`, `passwordText`.

   Removed: none.

   Changed: `BookmarkTracker`, `BuildDerivedListQueryOpts`, `CliIo`, `SessionHandle`, `ShardDbHandle`, `ShardMove`, `ShardResolverDeps`, `ShardRouter`, `defineConfig`, `openD1Session`.

   `BuildDerivedListQueryOpts` takes `dialect`, `"postgres"` or `"sqlite"`, for a derived list whose id and keys hold no column.

   `CliIo` takes `locatePeer`, which finds an optional peer's entry before a migrate command's first I/O; leave it out to find each peer as comb and `bun` do.

   The D1 modules type a binding, a session and a statement by the methods comb calls on them, so a Worker typed by `wrangler types` and one typed by `@cloudflare/workers-types` both fit. `openD1Session` and `SessionHandle` are generic over the binding and hand back its own session type; `BookmarkTracker.track` takes any D1 session; `ShardMove.with` takes the caller's prepared statements; `ShardResolverDeps.coreDb` takes either binding; `ShardDbHandle<D1Database>` types the shard's binding as the caller names it, and from 0.21 `ShardRouter.getHandle()` reads it from the env.

2. **State `dialect` on a derived list of SQL expressions alone.** `buildDerivedListQuery` reads its database from the columns its id, anchor and sort columns hold, wherever an expression holds them (inside an `` sql`…` `` template, an alias, a `{ sql, type: "date" }` key or a subquery's field), and a list whose id and keys are all SQL expressions, such as a union inbox, must state `dialect: "postgres"` or `dialect: "sqlite"`: building it without one throws a TypeError naming `dialect`, on every page. 0.19 read the database only from a column given as the option itself, so a Postgres list whose columns sat inside an expression, or that held none, sent SQLite's `typeof()` and every page failed with `function typeof(bigint) does not exist`. A list whose id and keys hold columns of both databases, or a column of neither (a MySQL table's), or that states a `dialect` its columns contradict, is refused the same way. **Fix:** add `dialect` where the TypeError names it.

3. **Set a connection pragma in each file that needs it, on SQLite, a libsql file and D1.** Each file now applies, and is proven, on a connection of its own, so a pragma a file sets (`PRAGMA ignore_check_constraints = 1`, `recursive_triggers`, `legacy_alter_table`, `case_sensitive_like` and the like) ends with that file, as on D1, where wrangler runs each file alone. 0.19 ran every pending file of an apply on one connection, so a pragma one file approved for itself stayed set for the files after it: a plain `INSERT` that breaks a `CHECK` committed when it shared a run with a file that set `ignore_check_constraints`, and was refused when applied alone; on D1, check passed it and wrangler then failed on it. Baseline's replay of the history runs each file on a fresh connection too. `PRAGMA hard_heap_limit`, `soft_heap_limit` and `temp_store_directory` with a value are refused at check, with no override: each is the process's setting, which reaches every connection and outlives the file. **Fix:** a file that relied on an earlier file's pragma sets it itself; set a heap limit or a temp directory where the application opens SQLite. On libsql over a network and on Turso, the server refuses those pragmas, and from 0.21 check refuses them ("Upgrading to 0.21"), so this fix applies to SQLite, libsql files and D1 only.

4. **Write a change to the server as a statement of its own, on Postgres.** `check` and baseline refuse a history file whose `DO` block, function, `EXECUTE` or `CALL` changes a role, a membership, a database, a setting, a comment or anything else the server's databases share, naming the file and the change, and roll it back on devUrl. 0.19 ran such a file as written and committed it, so a `DO $$ BEGIN CREATE ROLE app; END $$` made the role on devUrl's server for good, the target's own when they share one, and the next check stopped on Atlas's "role already exists". A devUrl whose role has `track_counts` off is refused, naming the setting. **Fix:** write the change as a plain statement (`CREATE ROLE app;`, `ALTER ROLE app CONNECTION LIMIT 5;`), which the replay leaves out or runs as before and apply runs; set `track_counts` on for devUrl's role if it is off.

5. **Regenerate for a nullable written JSON field's shape.** A nullable `c.json`, `json`, `jsonb` or SQLite `text({ mode: "json" })` field in a create or update DTO is its schema behind `z.lazy`, nullable as every other field is, so `.unwrap()` takes it as a required input and keeps its `x-comb-text` and `x-comb-maxBytes`; it publishes `anyOf: [{ <schema>, "x-comb-*" }, { type: "null" }]` (since 0.20.1; 0.20.0 nested the schema in a one-member `anyOf`), the keys on the property as before. 0.19 built it as one union with null, so `.unwrap()` did not exist on it (TS2339) and its published non-null member carried no keys. A nullable real's read repeats its stated bounds on its number member the same way. A reader of the property's keys sees no change. **Fix:** regenerate.

6. **Install each optional peer inside comb's range.** comb now refuses an optional peer whose version is outside the range it states, naming the version found, where 0.19 ran it: `bun add libpg-query`, `bun add @libsql/client` and `bun add postgres` take 18.x, 0.18.x and 4.x today, which comb was never tested against. Install by the words the refusal gives, quoted for the shell, such as `bun add "libpg-query@>=17.7.4 <18"`. Each `comb migrate` command checks its peers before its first connection, request, process or Atlas call, so a Turso `apply` without `@libsql/client` no longer creates the database and mints a token before it refuses.

7. **Validate a password before it is hashed, not after.** A `password` column's DTO now holds the hash the column stores, any storable text under its declared `max` and `pattern`, where 0.19 held it to 8 to 72 printable ASCII characters and refused a declared `max` past 72: a 91-character PBKDF2 hash or a 106-character argon2id one failed the create DTO, while a plaintext passed it. A declared `pattern` now applies to the hash. **Fix:** a project that writes the hash through the DTO needs nothing; drop a `max` it declared to fit under 72 if its hashes are longer, and validate the plaintext in the request body with `passwordText()` (15 characters at least) and the sign-in body with `passwordText.typed()`. anyrow's column declares no `max`, so it drops nothing.

8. **Name the binding type a shard handle is, if you pass it on.** `@cloudflare/workers-types` is no longer a peer of comb, so a Worker typed by `wrangler types` installs nothing for comb's D1 modules, and a Worker typed by `@cloudflare/workers-types` keeps it as its own dependency. 0.19 required it: a project on `wrangler types` installed it only for comb, and its globals and the package's declared `D1Database` twice. `ShardRouter.getHandle()` now types its handle structurally; one passed to `drizzle()` or a function typed by `D1Database` fails to compile (TS2345). **Fix:** on 0.21, call `getHandle(mapping, env)`, whose handle is the env's own binding type (0.21's step 8); remove `@cloudflare/workers-types` if comb was the only reason it was installed.

9. **Call `defineConfig` inside a config function, not around it.** `defineConfig` takes an object only, so `defineConfig(async () => ({…}))` fails to compile with TS2345 (`Argument of type '() => Promise<…>' is not assignable to parameter of type 'CombMigrateConfig'`). 0.19 took the function, and TypeScript checked no key of the object it returned, so a misspelled `local` or `migrationsDir` there compiled. At load, a function export that returns a function, as an untyped config of the old form wrapped in another function does, is refused naming the form. **Fix:** `export default async () => defineConfig({…})` in place of `export default defineConfig(async () => ({…}))`; an object config needs nothing. anyrow's configs need no change.

10. **Expect a role check replays to have no login and no options, on Postgres.** A history's `CREATE ROLE` or `CREATE USER` makes the role on devUrl's server `NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS` while check or baseline replays it, keeping `IN ROLE`, `ROLE` and `ADMIN` only among roles that replay made, since the replay needs only its name, for an owner, a grant or a policy. Check prints a line for each one that asked for more. 0.19 made it as written, so a `CREATE USER ops SUPERUSER PASSWORD '…'` in a pending file left a superuser that could log in to devUrl's server for as long as the check ran, and for good when a killed check left it. Apply makes the role as written. **Fix:** none.

## Upgrading to 0.19

What changes for a project on 0.18. Before deploying it:

1. **Know what changed in the API.** A test holds these three lists to the exports themselves.

   New exports: none.

   Removed: none.

   Changed: `MANIFEST_VERSION`, `ManifestColumn`, `SpellfixDb`, `SpellfixSearch`, `buildManifest`, `defineConfig`.

   `buildManifest(tables, dbName, dialect)` takes the dialect, which decides what a column holds, as the DTO's does. `defineConfig` also takes a function, sync or async, that returns the config, and returns what it was given, so a config that reads its secrets asynchronously is typed too; an object passes as before. `buildFtsWhereWithSpellfix` keeps its spellfix1 probe per client, read from `SpellfixDb`'s optional `$client` (a drizzle database has it), so a wrapper built per request asks once; `SpellfixSearch` takes `spellfix: false`, which asks nothing and searches the terms as typed (D1). Both are additive.

2. **Regenerate, and widen what codegen refuses.**
   - The manifest is `v` 2: each column's `min` and `max` are the bounds the create DTO enforces, not the declared ones (a password's 8 to 72, a required text's 1, a format's floor, an id's 1 to 48, an integer's clamped to the column), `patterns` lists every regex it checks, the kind's own beside the declared one, in place of `pattern`, and `maxBytes` is a `c.json` column's byte limit. A reader of `v` 1 refuses it; read `patterns`, then regenerate committed manifests (meta-contract §8.2).
   - A Postgres read array of a bounded text, integer or real states its element's `x-comb-*` bounds on every level's `items`, where 0.18 left them inside the first `anyOf` member of each, as meta-contract §2.1 says. A reader of `items["x-comb-*"]` finds them; regenerate.
   - An entity file imports `jsonValueSchema`, `cidrSchema` or `timestampSchema` only where a field uses it. 0.18 imported one whenever a field's code contained the name, so a `c.json` schema exported as `jsonValueSchemaStrict`, `cidrSchemaDoc` or `timestampSchemaDoc` made the file fail a consumer's `noUnusedLocals`; regenerate.
   - A nullable plain json or jsonb column's read publishes null once: `z.json()` holds null, and 0.18 added a second `{ type: "null" }` beside it. The type is unchanged; regenerate.
   - A password's declared `max` past 72, bcrypt's limit, fails codegen naming the column; 0.18 held the column to 72 whatever it declared. **Fix:** declare 72 or less, or drop the `max`.
   - A nullable field's `x-comb-*` keys sit on its non-null member too, with the same values, so a schema composed from it with zod's `.unwrap()`, `.optional()`, `.pick()` or `.extend()` keeps them. 0.18 put them on the nullable alone, so `.unwrap()`, the usual way to take a nullable column as a required input, dropped its transform and storable-text keys. A reader still reads the property's keys (meta-contract §2.1); regenerate.

3. **Move the peers inside the new ranges.**
   - `drizzle-orm` and `drizzle-kit` admit `1.0.0-rc.4 || 1.0.0-rc.5 || ^1.0.0`. 0.18's `>=1.0.0-rc.4 <2` admitted the tagged 1.0.0-rc.5, drizzle's `rc` tag, which failed strict `tsc` in comb's D1 sharding types; 0.19 type-checks on rc.4 and rc.5 both. It also admitted drizzle's `1.0.0-rc.N-<hash>` branch builds, which rank above the tagged rc, and the README's install line resolved drizzle-orm's `latest` tag, 0.x, outside the range. **Fix:** install a tagged release inside the range: `drizzle-orm@1.0.0-rc.4` or `@1.0.0-rc.5`, and `drizzle-kit` at the same version where installed.
   - `@cloudflare/workers-types` starts at `5.20261001.1`, the floor wrangler 4.147.0, comb's wrangler floor, peers on; 0.18's floor of `5.20260815.1` could not install beside it. **Fix:** move to `5.20261001.1` or later.

4. **Rename a migrate config by a retired name.** comb reads only `comb.migrate.config.ts` and `comb.migrate.config.js`. 0.18 also read `db-migration.config.ts`, `migration.config.ts` and their `.js` twins, names other migration tools use, and ran such a file as code. A project with one of those and no comb config now fails every `comb migrate` command without running it, naming the file. **Fix:** rename it to `comb.migrate.config.ts` if it is comb's; if it is another tool's, add a `comb.migrate.config.ts` beside it.

5. **Point a Postgres baseline with other statements at a `postgres://` devUrl.** On a `docker://` devUrl, baseline goes ahead without comb's replay only when every history statement is one comb has proved makes nothing it compares, and refuses any other, naming devUrl. 0.18 passed any statement not on a list of those that make such objects, so `ALTER SEQUENCE … OWNED BY NONE`, which frees a serial's sequence, passed the gate and then refused the very database the history built, as drift. A history with an `ALTER … OWNER TO`, `SET SCHEMA`, `CREATE STATISTICS`, `ALTER DEFAULT PRIVILEGES` or any other statement outside the list now refuses there. **Fix:** set `devUrl` to a `postgres://` scratch database comb can connect to, where it replays the history.

6. **Grant CREATEDB to the role of a `postgres://` devUrl.** `check` and `baseline` replay the history as Atlas applies it, each file in a transaction of its own, in a database they make from `template0` on devUrl's server and drop after. 0.18 replayed the whole history in one transaction on devUrl's own database, which filled Postgres's lock table on a long history, left a seed's deferred trigger events pending, and let what that database held decide the verdict. A role without CREATEDB is refused, naming the privilege. **Fix:** `ALTER ROLE <role> CREATEDB` for devUrl's role, or point devUrl at a role that has it.

7. **Move an `ALTER SUBSCRIPTION … SET (failover)` into a `-- atlas:txmode none` file.** Postgres 17 runs it only outside a transaction block, and `check` now refuses it anywhere else, naming it as Postgres does. 0.18 rated it a statement comb does not recognize, to approve in the file, and Atlas's file transaction then refused it at apply.

8. **Take `PRAGMA query_only` out of a SQLite or D1 migration.** `check` refuses it with any value, however it is written (`'1'`, `01`, `"on"`, `0`). 0.18 refused only the values it read as on, so `'1'` and `01` passed `check` and the file failed read-only at apply. Off does nothing on a connection comb opens, so no file loses anything. A pragma's single-quoted value is read as SQLite reads it, so `PRAGMA defer_foreign_keys = 'on'` is rated as comb writes it. `PRAGMA foreign_keys` other than on, yes, true or 1, in any case and quoted or not, gets the cautious note that it does nothing inside the transaction comb runs each file in: SQLite reads a word it does not know (`'nope'`, `full`) as off, and SQLite versions read a number like `256` apart. 0.18 noted only `off`, `false`, `no` and `0`, and rated any value but on, off, true, false, 0 and 1 unsafe. **Fix:** write `on` where a file means on.

9. **Read `unknown` in a `--json` report.** Every `migrate apply`, `check` and `status` object gains `unknown`, the files that may have committed, `[]` when none. On libsql, Turso and bun:sqlite, a file whose batch committed while its answer was lost, the connection staying down through every retry, is in `unknown`, in neither `applied` nor `pending`, and its refusal names the file and the cause (`fetch failed: read ECONNRESET`) and says to run `comb migrate status`; 0.18 listed it as pending. On D1, a read-back that fails after wrangler's apply puts the files it ran in `unknown` too, where 0.18 listed them as pending.

10. **Leave D1's new `_comb_migration_hash_intents` table to comb.** Apply on D1 writes each checked file's hash there before `wrangler d1 migrations apply` runs, and moves it to `_comb_migration_hashes` once wrangler's table names the file. 0.18 wrote the hash itself first, so when wrangler then ran nothing, the row outlived the apply, and every later command refused a file fixed and applied by wrangler alone, as applied and then as edited. The first apply that writes an intent makes the table; `d1HistoryTables()` lists it, and comb's own schema reads leave it out, as they do its other history tables. **Fix:** a hand-written list of comb's tables that a schema tool skips adds it; one built from `d1HistoryTables()` needs nothing.

11. **Drop a tsconfig mapping into comb's source.** A consumer's `tsc` now reads comb's declarations, so it needs no flag and no longer checks comb's internals. A `paths` entry or a `customConditions` mapping that sends `@lovrozagar/comb` to its `src` bypasses them and keeps the 0.18 behavior, `allowImportingTsExtensions` and all. **Fix:** remove the mapping; `allowImportingTsExtensions` can go too, unless your own imports end in `.ts`.

## Upgrading to 0.18

What changes for a project on 0.17. Before deploying it:

1. **Know what changed in the API.** A test holds these three lists to the exports themselves.

   New exports: `ListExtra`, `ListRow`, `defineConstraintMaps`.

   Removed: none.

   Changed: `CliIo`, `DatabaseErrorHandler`, `ListExtras`, `ListQueryInput`, `ListQueryOutput`, `ManifestColumn`, `TursoProviderConfig`, `classifyD1Error`, `classifyPgError`, `classifySqliteError`, `constraintError`, `d1ErrorHandler`, `handleConstraintViolation`, `paginateMerged`, `parseConfig`, `pgErrorHandler`, `sqliteErrorHandler`.

   `ListRow` and `ListExtra` are `/query`'s, and `defineConstraintMaps` is the package root's: it checks the constraint maps an app passes its error handlers where it builds them, and the handlers take the maps as `readonly ConstraintMap[]`. `parseConfig` is async, and takes what a config module exports, an object or a function, sync or async, that returns one: `parseConfig(imported)` becomes `await parseConfig(imported)`, and a refusal rejects with the same ZodError. `TursoProviderConfig.group` is optional, as it always defaulted to `default`. `paginate` and `paginateMerged` return `Array<ListRow<T>>`, which drops the extras from each member of a union row type on its own, so narrowing on a discriminant reaches each variant's fields again; 0.17's `Omit<T, ListExtra>` kept only the keys every member shares.

2. **Regenerate, and widen what codegen refuses.**
   - A nullable `c.json` array takes null on a write again, as on 0.16; 0.17 refused it. Regenerate.
   - A written url publishes `x-comb-transform: ["trim"]`, as z.url() always trimmed it unpublished; regenerate, and a client that validates from the spec trims first. The manifest gains `textKind` and `transform` on every column (additive, `v` stays 1); regenerate committed manifests. meta-contract §2.1 defines each transform exactly, with fixtures, and states that the bounds bind the transformed value.
   - A format's shortest value joins a text's range: email 6, imageUri 8, url 9. A declared max under it fails codegen (it refused every value), and a declared min under it is raised. A written email, url or imageUri publishes that minLength; regenerate.
   - A plain json or jsonb column's write DTO takes null only where the column does: a NOT NULL one refuses null with a 400, where it took it and the insert failed with 23502; a nullable one publishes null once. Regenerate.
   - Every `x-comb-*` key sits on the property's own schema, beside a nullable field's `anyOf` (`items` for an array element's), never inside an `anyOf` member, where a nullable text's sat. A reader of `x-comb-transform` or `x-comb-text` reads `properties[name]`. Regenerate. A generated nullable field's keys sit on the nullable, so `.unwrap()` drops them: a read DTO's field also validates nothing, so an input takes the field from the write DTO instead.
   - A text takes one kind of email, url, password, imageUri and name: a second fails codegen ("email and url contradict; declare one"), as does a key its kind would drop: uppercase on an email, lowercase or uppercase on a url, trim or casing on a password. An email's own trim and lowercase, and a url's trim, may still be declared. **Fix:** drop the key or the second kind; each was ignored without a word.
   - A `c.json` `maxBytes` now measures every value. A falsy value used to skip the check, so `false` passed a limit under 5 bytes. Only a `maxBytes` under 5 is affected.

3. **Check your configs and scripts.**
   - A name or path a config states is refused at load when blank (whitespace only), naming the key: in comb.migrate.config.ts `migrationsDir`, `name`, `codegen`, `drizzleConfigPath`, an environment's key, a bun:sqlite `path`, D1 `databaseName`/`wranglerConfig`/`wranglerEnv`, Turso `databaseName`/`org`/`group`, a Postgres `schema`; in comb.config.ts `tables`, `filePrefix`, an `output`, an FTS table or column, a partition. comb.config.ts refuses an empty `databases` ("databases declares no database"), so `comb codegen` no longer exits 0 having generated nothing. A blank libsql `url` or Turso `apiToken`, resolved at use, is refused as an empty one is, before anything is sent.
   - A word comb would drop now exits 1 with the usage line: a database beside `codegen --tables` (direct mode wrote its files whatever was named), and any word after `help`, `-h`, `--help`, `--version` or `migrate help`. A word beside a command's own `--help` still shows that help.
   - `--json=1` (or `--json=`) now gets its refusal as the one JSON object on stdout, as `--json` does.

4. **On SQLite and D1, check what you apply.**
   - Apply records the checked files' hashes before `wrangler d1 migrations apply` runs, as intents in `_comb_migration_hash_intents` (0.19), and moves each into `_comb_migration_hashes` once wrangler's table names its file, so a hash row is always the text that ran. Baseline writes the hashes before wrangler's rows, and a rerun copies every vouched file that lacks either row; its summary adds `, N hashes recorded` when it finishes a half-done baseline. A read-back that fails after wrangler ran is a `Refused` naming the files (`--json` `pending`), and says to run status.
   - A D1 apply under 0.17.0 whose hash record was lost after wrangler committed left those files applied with no hash; `comb migrate status <db>` names them ("No hash recorded for …"). 0.18 cannot heal them (nothing vouches for their content): check each against git from the commit that applied it, then run `comb migrate baseline <db> --hashes` once.
   - More pragmas are refused before they run, with no override, however the name is quoted (`"journal_mode"`, `[journal_mode]`, `main."journal_mode"`): on every SQLite target `journal_mode` (any form), a `synchronous` change, `query_only` on and `wal_checkpoint`, which SQLite refuses inside the transaction comb runs each file in; on D1 also every pragma its authorizer does not run (Cloudflare's list, plus `page_size`, `data_version` and `optimize` as reads). A file that check passed under 0.17 with an approval, and that could never apply, is now refused at check. A quoted `foreign_keys` or `writable_schema` is rated as the bare name is, and a quoted `defer_foreign_keys` is safe.
   - A file's cautious statements are shown on every path it takes: an unsafe file's refusal lists them after its unsafe ones (`is unsafe (…); also cautious: (…)`), a terminal question names them, and a file approved in-file or run with `--yes` prints `Cautious in <file>: <statement> (<note>)` for each. `PRAGMA foreign_keys = on` (and a read of it) is safe now; only `off` carries the note that it does nothing inside comb's transaction.

5. **On Postgres, read what baseline now needs and compares.**
   - Baseline no longer models the history; it replays it on the dev database (comb's objects included) in one transaction it rolls back, and compares the target's catalog with the replay's, read by one query. **Fix for a project on the default devUrl (`docker://postgres/17/dev`) whose history makes functions, triggers, views, materialized views, sequences, policies, domains, composite or range types, collations, rules, extensions or row level security:** set `devUrl` (the provider's or the environment's) to a `postgres://` scratch database comb can connect to (for example a `postgres:17` container you run, or a branch of a scratch server). baseline now refuses with that docker devUrl, naming it; a history of plain tables still baselines with it. A history that cascades, renames or moves what the old model missed (an operator's function, a BEGIN ATOMIC body, a type, a rule, an extension, a kind moved schema) now baselines; a statement Postgres runs only outside a transaction stops baseline naming it. Combined row level security commands (`ALTER TABLE t ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY`) are read from the parse tree, and policy roles compare as Postgres stores them. The `UNCOMPARED` warning is unchanged.
   - Baseline now also compares aggregates, SECURITY DEFINER, operators, casts, views' and materialized views' options, materialized views' indexes and a table's non-default replica identity, and refuses when the history makes an event trigger or a publication the database lacks (one the database has and the history does not is the platform's, and passes). A target that differs from the history in any of these, and baselined before, now refuses naming it. **Fix:** make the database match the history (or add the migration that makes it), then baseline again. The every-run `UNCOMPARED` warning now names what neither Atlas nor comb compares: views' and policies' queries and checks, triggers' WHEN clauses, view columns' defaults, columns' statistics targets, statistics objects, text search configurations and dictionaries, foreign data wrappers, servers and user mappings, grants and comments. The refusals' list of compared kinds is generated from the catalog read, so its text changed (it now names procedures, domains, composite and range types and the new kinds); a script matching the old sentence must match the new one.
   - A history holding `DROP EXTENSION … CASCADE` (or a cast, language, operator, publication, event trigger, access method, foreign data wrapper, server, transform or routine dropped CASCADE) no longer crashes check and apply of every later file with a raw TypeError; v0.17.0 projects stuck on it are unblocked by the upgrade alone.
   - A history with a statement that depends on a view (a LANGUAGE sql function reading it, a function returning SETOF it, a column of its row type, a view over an extension's function) no longer stops `migrate diff` and baseline with Atlas's raw "relation does not exist": Atlas's replay now runs each view (and, for baseline, each extension) where it stands, inside a DO block Atlas does not inspect. Nothing a project writes changes; such a history now diffs and baselines.

6. **On Postgres, expect check to refuse more.**
   - `comb migrate check` now replays the history and the pending files on devUrl in one transaction it rolls back, before any approval, and refuses a statement Postgres refuses there, naming the file, the statement and Postgres's message. That covers a retype of a column a view, a materialized view, a rule, a policy, a trigger's WHEN, a generated column or a BEGIN ATOMIC function reads, and anything else no database runs. A statement a transaction cannot hold, which a `-- atlas:txmode none` file runs (ALTER SYSTEM, CREATE DATABASE, BEGIN/COMMIT), is left out and named. A CONCURRENTLY detach replays without the keyword. **Needs:** devUrl reachable from where check runs, holding what the history needs from the server (its roles, its extensions), and the `postgres` package. With the default `docker://` devUrl, or without `postgres`, check prints "Check did not replay the pending files on devUrl: …" and rates the files alone, as before. `comb migrate apply` does not replay.
   - A statement Postgres runs only outside a transaction is now read from its parse tree, and check refuses it anywhere but a `-- atlas:txmode none` file, naming it as Postgres does. That adds DETACH PARTITION … CONCURRENTLY, a bare CLUSTER, REINDEX SCHEMA, DATABASE and SYSTEM, ALTER SYSTEM, CREATE and DROP DATABASE, ALTER DATABASE … SET TABLESPACE, CREATE and DROP TABLESPACE, DISCARD ALL, COMMIT and ROLLBACK PREPARED, a CREATE SUBSCRIPTION that makes a slot, DROP SUBSCRIPTION, and ALTER SUBSCRIPTION … REFRESH or a refreshing publication change. **Fix:** move each into a file of its own that starts with `-- atlas:txmode none` and a blank line. A CREATE SUBSCRIPTION WITH (connect = false) now replays on baseline's dev database.
   - Adding a column of a domain now reads the domain the history leaves, through its base domains, ALTER DOMAIN, RENAME, SET SCHEMA and DROP. A domain NOT NULL with nothing to fill it is unsafe, since Postgres fails it on a table with rows, and a domain with any CHECK or NOT NULL warns of the table rewrite, with or without a default. A renamed or moved domain's volatile default still warns, and a dropped one no longer does. A migration that checked clean before may now ask for approval. **Fix:** give the column a default, or add it nullable and backfill, as for an inline NOT NULL.
   - An added column's inline `REFERENCES` no longer warns of a rewrite; with no default it scans nothing, and with one it warns of the scan of both tables. A NOT VALID foreign key on a partitioned table, which Postgres refuses, is refused at check with the recipe (NOT VALID and VALIDATE on each partition, then the parent's ADD, which then scans nothing), and a valid one warns that it scans every partition.
   - No lock warning for a partitioned index's SET TABLESPACE, which moves no storage, or for an added column of an array of a domain, which takes no default from the domain.
   - ATTACH PARTITION … DEFAULT's warning says Postgres checks the partition for rows another partition's bound takes, and the recipe is a CHECK excluding every other bound, NOT VALID, VALIDATE, then ATTACH.
   - An unrecognized statement is named by Postgres's command tag (`ALTER DEFAULT PRIVILEGES`, `CREATE TEXT SEARCH CONFIGURATION`, `CREATE USER MAPPING`), and a `PREPARE` is cautious, rated as itself; its EXECUTE is rated by what it runs. An event trigger's `WHEN TAG IN ('CREATE TEXT SEARCH CONFIGURATION')` (and the dictionary, parser, template, large object, server and foreign data wrapper tags) now matches what Postgres fires it on.

7. **On Postgres, check your URLs.**
   - DevUrl is checked before comb writes to the dev database, so a refused `migrate diff`, baseline or adoption writes nothing, and a devUrl TLS problem is named ("devUrl's sslrootcert … cannot be read") for every schema, where a non-public one got a bare ENOENT. **Programmatic:** `generateSchemaDiff`'s `target.devUrl` must be a scratch database; give `target.url` too, since without it comb cannot tell devUrl from your real database.
   - A url or devUrl naming a libpq `service` is refused (Atlas read `~/.pg_service.conf` over the URL while comb read the URL), and Atlas runs with PGSERVICEFILE at /dev/null. A libpq key Atlas's driver sent the server as a setting, which failed every Atlas call, is dropped from Atlas's URL when it only tunes the connection (keepalives, keepalives_count/_idle/_interval, gsslib, sslcompression, channel_binding or gssencmode other than require) and refused by name otherwise (channel_binding=require, gssencmode=require, require_auth, requirepeer, sslcrl, sslcrldir, sslpassword). **Fix:** write a service's host, port, dbname and user into the URL; drop a refused key. Neon's default `channel_binding=require` is refused: drop it, and keep `sslmode=require` or `verify-full`.
   - `sslrootcert=system` is taken, verifying against the OS trust store (Node's CAs for comb's own reads) with sslmode=verify-full, which it implies with no sslmode; any weaker sslmode with it is refused, as libpq refuses it. A missing or unreadable sslrootcert, sslcert or sslkey under sslmode=disable, allow or prefer is no longer refused, since nothing reads it there. **Stricter:** an encrypted sslkey under require or verify-*, which Atlas's driver cannot read, is refused with the `openssl pkey -in <key> -out unencrypted.key` line, and so is any sslpassword. **Fix:** decrypt the key, and drop sslpassword.
   - An sslcert without sslkey under require or verify-* is refused at check, as libpq ("certificate present, but not private key") and Atlas's driver (which looks for ~/.postgresql/postgresql.key) refuse it. **Fix:** name the key with sslkey.
   - Comb's own reads verify sslrootcert=system against the CAs Atlas's driver reads, so one URL verifies one way: on Linux the system's CA files (SSL_CERT_FILE or the distribution's bundle, plus SSL_CERT_DIR or /etc/ssl/certs), elsewhere Node's system store from Node 22.15. Under Bun or an older Node off Linux, comb verifies against the runtime's bundled CAs, and a verification failure says so.
   - Comb's own reads match a passfile line's host as Atlas's driver does, so comb and Atlas take one password from one file. A URL with a hostaddr and no host matches `localhost`, no longer the hostaddr (0.17 followed libpq there), and a socket matches its directory or `localhost`, whichever line comes first. **Fix:** key a hostaddr-only URL's line to `localhost`, or give the URL its host.
   - The plaintext-password warning reads the sslmode comb connects with, so a URL with no sslmode (require) or sslrootcert=system alone (verify-full) no longer warns, and any 127.0.0.0/8 or ::1 address counts as local.
   - A URL naming several hosts (in the authority, or as a host, hostaddr or port list) is refused by name, where it was refused with the password hint or passed. A passfile libpq ignores, because it is not a plain file or is readable by others, is refused at check, by field, when the URL has no password; one comb cannot stat or open gives no password, as libpq's does. **Fix:** name the primary host alone; name the password file itself, and chmod 600 it.

8. **Check your lists, errors and search.**
   - `limitBounded` and `pageBounded` are gone; a list schema's output carries `limitBound` and `pageBound`, its own maxLimit and maxPage as numbers, and each holds the limit or page wherever it is read. `{ ...parsed, limit }` used to pass any limit; it is now a 400 past the schema's maxLimit, and fine under it. A hand-built query that set `limitBounded: true` states its bound: `limitBound: MAX_EXPORT_ROWS`. An extension may not be named `limitBound` or `pageBound`.
   - A derived list with no `anchor` refuses, as `sort_not_wired` (500), the page whose cursor would carry an integer sort key the driver read as a number past ±(2^53 − 1): it skipped rows or served one forever. D1 reads every INTEGER as a number, so such a list on D1 needs its `anchor`. **Fix:** name the `anchor` (the keyset reads the exact key back from its row), or read the key as bigint.
   - Every list pages on it. _total and _combAnchorGone take the driver's decimal strings (count as a number); a number column, the tiebreak and a time key take a canonical integer string; a SQLite derived list sorted by an undeclared expression selects a new extra, `_combKeyTypes` (SQLite's typeof of each sort key), so an integer expression resumes as the integer it is. **Wiring:** a hand-rendered select of the extras must render `_combKeyTypes` too, or the page is page_not_wired; the row type of applyListQuery gains `_combKeyTypes?: string`, which paginate strips.
   - A merged list over libsql shards in intMode "string" pages, where every page was refused as a collation fault (the merge compared 12 before 3 as text); the merge compares a number column's decimal string, and a numeric tiebreak's, as the integer.
   - A constraint map key with a `*` anywhere but its end no longer throws a TypeError in place of the database error at the first violation; the violation is classified with the well-formed keys and the key is warned of once (`comb.constraint-maps.error`). New `defineConstraintMaps(...maps)` (root export) refuses such a key at module load and returns the array frozen; handlers take `readonly ConstraintMap[]`. **Fix:** build the maps with it.
   - BuildFtsWhereWithSpellfix searches the terms as typed again where spellfix1 is not loaded (D1, stock bun:sqlite and libsql), as 0.16 did; 0.17 threw drizzle's DrizzleQueryError on every term of three or more characters. It asks each database once, with editdist3, before any spellfix query; with the extension loaded, a missing or misspelled vocabulary table still throws. Driver errors are read along their whole cause chain by every classifier.

## Upgrading to 0.17

What changes for a project on 0.16. Before deploying it:

1. **Regenerate, and widen what codegen refuses.**
   - A text whose bounds leave no value once comb's own are counted fails codegen, naming the column: a `password` with a `min` past 72, a required text with `max: 0`, a `url` with a `max` under 9. 0.16 wrote a `_shared` module that threw on import, or a DTO that refused every value. A text declaring both `lowercase` and `uppercase` fails too ("lowercase and uppercase contradict; declare one"), where lowercase won without a word.
   - A written text with `trim`, `lowercase` or `uppercase`, and every written email, publishes `"x-comb-transform": [...]` in its JSON Schema, in the order applied, on the non-null branch of a nullable field. Its published bounds and pattern bind the transformed value, so a client that validates from the spec applies the transforms first (meta-contract §2.1, §6.9).
   - A nullable written `c.json` publishes one flat `anyOf: [<schema>, { type: "null" }]`, its `x-comb-*` keys beside it, where 0.16 nested a one-member `anyOf` inside the nullable one. A registered schema with `maxBytes` publishes its bare `$ref`, where 0.16 inlined its body beside it; the byte limit and the U+0000 rule are one check, each still its own issue. A consumer that matched the nested shape reads the flat one.
   - Generated DTOs name `Array`, `Set` and `undefined` as `globalThis.Array`, `globalThis.Set` and `void 0`, so a schema module exporting a value of a global's name no longer breaks a multi-dimensional array's write. `_shared`'s `_m` is `as const`.
   - The constraint map keys every table, one with no constraint as `table: {}`, and lists a Postgres table's partitions under `partitions` from `comb.config.ts`'s new `partitions: { parent: ["partition", …] }` (step 2).
   - `comb.config.ts` refuses an FTS table with no column, at its path. Under `isolatedDeclarations`, the constraints, entities, enum-checks, error-keys, field-names, rows, rqb-cols, sql-cols and table-names files compile; the DTO files, `_shared`, relations and orm do not, so keep those in a tsconfig without the flag.

2. **Key every table your errors should name.** A violation on a table the maps given key nowhere names no column, in its `column` or its cause, on every dialect, as on Postgres since 0.16: a table a trigger writes outside the schema, say. Regenerated maps key every table of the schema. Tables your app creates at run time take a prefix pattern beside the generated map, and are named again:

   ```diff
   - onError: (error) => sqliteErrorHandler(error, [DB_CONSTRAINT_MAP])
   + const MAPS = defineConstraintMaps({ ...DB_CONSTRAINT_MAP, "ut_*": {} })
   + onError: (error) => sqliteErrorHandler(error, MAPS)
   ```

   A key ending in `*` keys the tables it prefixes, the longest pattern winning and a table's own key over any; a `*` anywhere else is a `TypeError`. On Postgres, a violation reported on a partition is read as its parent's only when the parent's entry lists it under `partitions`; 0.16 read any table no map knew as the statement's own, which named a private column under the wrong table when a trigger wrote it. A partitioned table lists its partitions in `comb.config.ts` (or a hand-written map adds `partitions: [...]` to the parent's entry), or its partitions' violations name no column.

3. **Expect new answers from the error handlers.**
   - A bare `SQLITE_CONSTRAINT` whose words name no kind is a 400 `constraint_violation` with the generic cause "Constraint violated"; only a trigger's RAISE (`SQLITE_CONSTRAINT_TRIGGER`, which libsql, bun:sqlite and D1 all report) shows its own message.
   - libsql's `batch()` classifies as `execute()` does: a STRICT mismatch through it is the 400 `invalid_value`, where it was a `constraint_violation` whose cause held the engine's text and the column.
   - On D1, an FTS5 table's duplicate rowid through `exec()` is the 409 `primary_key_violation` that `prepare()` and `batch()` give.
   - On libsql and Turso, a refused or lost connection (`ECONNREFUSED` and the codes Postgres reads, `HRANA_WEBSOCKET_ERROR`, an idle stream sqld expired, `STREAM_EXPIRED`) and a `SERVER_ERROR` whose response was a 5xx or a 429 are the 503 `database_unavailable` that D1 and Postgres give. A host that does not exist and a request the server refuses stay unclassified.

4. **Check your lists.**
   - A list schema brands its limit (`limitBounded`) as it brands its page: a hand-built `limit` past `PAGINATION_DEFAULTS.maxLimit` (100) is a 400, as a hand-built page past `maxPage` is. Page a hand-built list within 100, or set `limitBounded: true` on it to assert a bound of your own, as `pageBounded` does for a page.
   - `paginate` and `paginateMerged` return `Array<Omit<T, ListExtra>>`: code that read `_total` or `_combId` off an item, always undefined at run time, no longer compiles. Each extra is held to its kind: `_total` a safe integer from 0 (a bigint taken as its number), `_combAnchorGone` 0, 1 or a boolean, `_combId` never the string `"_combId"`; anything else is a 500 `page_not_wired` naming the raw-SQL form.
   - `buildDerivedListQuery` takes `merged: { maxRowsPerShard? }`, as `buildListQuery` does, for a union or join whose rows sit on several shards; page it with `paginateMerged`. A merged derived list takes `idColumn`, not `anchor`, and its rows carry each sort field under its name.
   - A merged list refuses, as `sort_not_wired` (500), a computed sort and a table with no id column when it is made, and in `paginateMerged` a rows' sort field missing or an integer sort key a driver read as a number past ±(2^53 − 1); read such a key as bigint. A `merged.maxRowsPerShard` that is not a whole number from 1 is a `TypeError`. A cursor whose anchor row is gone and whose integer key is past 2^53 resumes from the edge of the key's rounding interval, skipping no row.
   - `buildFilterSQL`'s `columnMap` takes `{ column, kind }` only: write `name: "name"` as `name: { column: "name", kind: "as-is" }`, which binds as the string form did. JavaScript that passes a bare name gets a `TypeError` naming the field.
   - `buildFtsWhereWithSpellfix` falls back to the terms as typed only when SQLite says spellfix1 is not loaded; a missing or misspelled spellfix table and a transient driver error are thrown.

5. **Check your configs at load.**
   - The `turso` provider requires `databaseName`, the Turso database's own name, as D1's does; 0.16 took the environment's `name`, which defaults to its key, so it could create a database called "prod". A Turso provider without it is refused at load.
   - `comb.migrate.config.ts` refuses an empty or blank `drizzleConfigPath`, an environment keyed by the empty string, an empty `databases` and a `lockTimeout` Postgres would not take; `migrate diff` refuses a `drizzleConfigPath` that is a directory. An empty postgres `devUrl`, libsql `url` or turso `apiToken` loads, and the command that resolves that environment refuses it by name.
   - `lockTimeout` is read as Postgres reads `lock_timeout`, once: a value past 2147483647ms, or one that rounds to 0ms, is refused; Atlas gets it in milliseconds, rounded half to even; a unitless fraction is milliseconds.
   - comb's own Postgres reads (baseline's catalog read, the dev-schema create) require TLS where the URL names no `sslmode`, as Atlas's driver does: a server without TLS takes `sslmode=disable`. They take the password from the URL's `passfile` when it gives none, as libpq does, matching a line's host to the host given, else the `hostaddr`; a passfile others can read is refused. Every Postgres command refuses an `sslmode` libpq does not take, or a TLS file it cannot read, naming the field. The plaintext-password warning judges the address connected to, `hostaddr` first.

6. **Re-check pending migrations.** Run `comb migrate check` on each environment before applying; ratings changed.
   - bun:sqlite applies with `PRAGMA foreign_keys = ON`, as libsql, D1 and the proof do: a file that relied on them being off now cascades or fails. `PRAGMA journal_mode` is refused, with no override; set it outside the migrations.
   - A refused libsql or bun:sqlite apply or baseline creates no database file. A D1 batch past 100 KiB runs as consecutive `--command` calls, never D1's import API; one statement past 100 KiB is refused before wrangler runs.
   - Postgres: a retype to or from an array is never a widening, and a widening retype that changes the column's collation rebuilds its indexes. An added column rates its domain's default, and an operator or cast as its function. An index or materialized view moved, and `ALL IN TABLESPACE`, warn of their rewrite. A new partition's lock warning names the parent's default partition. A foreign key's warning names the tables it scans and says to add it `NOT VALID`, then `VALIDATE CONSTRAINT`. `ENABLE` and `DISABLE RULE` read the rule family's rule; `LOCK` and `REFRESH MATERIALIZED VIEW` are rated by their lock alone. A `CASCADE` drop takes its dependents out of the history's facts; a trigger on a view, or an `ALTER TABLE` naming one, is about that view; what a view or policy reads comes from its parse tree. A statement two readings rate is listed once, its notes joined by "; ".
   - A Postgres baseline compares domains, composite and range types, rules, collations, the extensions the history creates, each table's row level security, a policy's command, roles and kind (a policy to `CURRENT_USER` as the role baseline connects as), and a sequence's settings. A database that lacks one refuses; it warns on every run of what it does not compare.

7. **Await `generateSchemaDiff`.** It is async (`/migrate`) and, on Postgres, readies the target's dev schema first, as `migrate diff` does; a dev database that is not empty is explained with comb's `devUrl` message.

8. **The CLI.** Every command refuses a positional it does not read, with its usage line: `migrate init postgres` (meant `--dialect postgres`) no longer drops a word. Wherever `--json` appears, a refusal on any command prints the one JSON object (`{ applied: [], database: null, pending: [], refused: [...] }`). `/cli` type-checks in a project with Workers' and Node's types and no DOM.

9. **Know what was added.** New exports: `parseConfig`, `DatabaseMissing` and `TursoMissing` (`/migrate`). A program that imports its config module calls `parseConfig(imported)` (or `loadConfig(path)`) to have it checked, as `defineConfig` only types it.

## Upgrading to 0.16

What changes for a project on 0.15. Before deploying it:

1. **Regenerate, then rename what codegen renames.**
   - Generated subpaths now split at acronyms and digits, as well as at a lowercase-to-uppercase step: `HTTPLog` is `http-log`, `oauth2Token` is `oauth2-token` and `apiKeyV2Token` is `api-key-v2-token`, so a camelCase and a snake_case spelling of one name now always meet. Rewrite the imports of any table whose name holds an acronym or a digit.
   - The run record is `.comb.codegen.gen.json`, named under the `.gen.` convention every formatter config ignores, so a format pass no longer rewrites it. comb does not read the old `.comb.codegen.json`: rename the committed file (`git mv .comb.codegen.json .comb.codegen.gen.json`), or delete it at the cost of one run that removes no stale file.
   - Generated DTO files reach comb's own predicates as `import * as comb from "@lovrozagar/comb"` (`comb.isStorableText`, `comb.isCidr`), and name every global they call through `globalThis`, so a `c.json` schema exported under one of those names can no longer replace it. A schema exported as `comb` or `globalThis` is imported under an alias. Every DTO file's text changes; its behavior does not.
   - A declared bound that holds no value fails codegen, naming the column: a `min` past its `max` on any column, a text `min` or `max` that is not a whole number from 0, a `maxBytes` that is not a whole number from 1. Each used to generate a module that threw on import, or a schema no value passed.
   - A nullable read float publishes `null` once (`anyOf [number, null]`, as a NOT NULL one does); parsing is unchanged. The manifest gains each entity's `partialUniqueIndexes`. Generated enum checks return `CheckBuilder[]` and each sql-cols record is typed `Pick<typeof <table>, …>`, so both compile under `isolatedDeclarations`.

2. **Select the built query's extras.** Every list builder returns `extras`, the columns `paginate` reads: the tiebreak (`_combId`), an offset page's count (`_total`) and, on a cursor that carries a reference, whether its anchor is gone (`_combAnchorGone`). Select them beside your own columns; `paginate` strips them. Rows that lack one the builder selected are a 500 `page_not_wired` naming it, on every page, where a forgotten count read as `count: null`.

   ```diff
   - db.select({ ...cols, ...queryHelpers.countExtra(q) }).from(t).where(q.where).orderBy(...q.orderBy).limit(q.limit).offset(q.offset)
   + db.select({ ...cols, ...q.extras }).from(t).where(q.where).orderBy(...q.orderBy).limit(q.limit).offset(q.offset)
   - const rows = await applyListQuery(db.select().from(post), built)
   + const rows = await applyListQuery((extras) => db.select({ ...getTableColumns(post), ...extras }).from(post), built)
   ```

   `queryHelpers.countExtra` is gone. A relational query passes `extras` on: `findMany({ ...options })`, or `findMany({ extras: options.extras, … })` beside your own fields. The next cursor's id is the `_combId` the builder selected, never a field of the row, so `buildDerivedListQuery` takes no `idField`: the tiebreak is its `idColumn`, or its `anchor`'s.

3. **Build a merged list with `buildListQuery`.** `mergedListOptions` is gone. Build the list once with `merged`, its filter, search and `baseWhere` as for one database, read it on every shard, and page it with `paginateMerged`:

   ```diff
   - const q = buildListQuery({ ...sealed, parsed, table: org, baseWhere })
   - const merged = mergedListOptions(parsed, sealed)
   - const rowsPerShard = await Promise.all(shards.map((db) => db.select({ ...cols, ...extrasOf(merged) }).from(org).where(q.where).orderBy(...q.orderBy).limit(merged.limit).offset(merged.offset)))
   - const [items, page] = paginateMerged(rowsPerShard, merged)
   + const built = buildListQuery({ ...sealed, parsed, table: org, baseWhere, merged: {} })
   + const rowsPerShard = await Promise.all(shards.map((db) => applyListQuery((extras) => db.select({ ...cols, ...extras }).from(org), built)))
   + const [items, page] = paginateMerged(rowsPerShard, built)
   ```

   The result is a `MergedListQueryResult`: `paginate` refuses it, and `paginateMerged` refuses a single database's list, in the types and as a 500 `page_not_wired`. Its window, count and null-anchor reads are the merged builder's own, so a filtered merged list no longer 500s on a cursor anchored on a null key. A merged list never pages by reference, since only one shard holds the row a reference reads back: a sort key too long for a cursor is a 500 `sort_not_wired` on the page that meets it, and a cursor that carries a reference is a 400 `invalid_cursor`.

4. **Rename the list input type.** `buildListQuery`, `buildDerivedListQuery` and `queryHelpers.listOptions` take one `ListQueryInput` (exported from `/query` and `/query/sqlite`), its arrays read only, so a hand-built `as const` query passes. `ListQueryParsed` is gone. `listOptions` no longer takes or returns `sortOrderBy`. A hand-built `limit` that is not a whole number from 1 is a 400 `invalid_page` naming the limit, as a page is. `ListQuerySchema` and `RetrieveQuerySchema` are exported from `/query`, so a module that exports a list or retrieve schema emits its declarations.

5. **Check your filters.**
   - An ISO date filter's validated value is an `IsoInstant` (exported from `/query`): `.ms` is its epoch milliseconds and `.text` its `toISOString()` text, and it writes itself as the text in a string or JSON. Code that compared it with `===` to a string reads `.text`. An instant its offset moves out of the years 0000 to 9999 is a 400, where it was a 500.
   - `buildFilterSQL` lowers each condition as `filterToSQL` does, `contains` and ISO instants included. A mapped column that stores something is `{ column, kind }`, `kind` one of `"text"`, `"number"`, `"numeric"`, `"date-ms"`, `"date-s"` and `"as-is"` (`ColumnKind`, from `/query/sqlite`):

     ```diff
     - columnMap: { createdAt: { column: "created_at", unit: "s" } }
     + columnMap: { createdAt: { column: "created_at", kind: "date-s" } }
     ```

   - `createListQuerySchema` refuses a `limits` value that is not a whole number from 0, a `TypeError` naming the key; write "no cap" as a large whole number.

6. **Check your configs at load.**
   - A migrate config database is either `name` and `provider`, or non-empty `environments` each resolving a provider; an environment's `name` defaults to its key. Both shapes at once, an empty `environments` and an environment with no provider are refused at load, naming the file. A `defineConfig` typo prints the same readable message, with the path, as a plain object's.
   - `comb.config.ts` is held to a strict schema: an unknown key (an FTS table's `contentTable`, which nothing read, included) is refused, naming the file. `FtsTableConfig.tokenizer` is typed `string | undefined`.
   - A Postgres `url` may be empty until a command resolves its environment. A URL with no user is the OS user's, its database that user's, as libpq reads it; comb's own reads take no `PGUSER`, `PGDATABASE` or `PGPASSWORD`. `hostaddr` is the address comb connects to and `host` the TLS name; `fallback_application_name` sets `application_name` where the URL names none.
   - The D1 provider connects to its own `databaseName`: `provider.connect(resolveDatabaseConfig(db, env))` no longer opens a D1 named after the environment.

7. **Re-check pending migrations.** Run `comb migrate check` on each environment before applying; ratings changed both ways.
   - Stricter: a SQLite file's own `BEGIN`, `COMMIT`, `END`, `ROLLBACK` or `START TRANSACTION` is refused, with no override. `ATTACH PARTITION`, `REFRESH MATERIALIZED VIEW` without `CONCURRENTLY` and `LOCK` in `SHARE` mode or stronger carry a lock warning. An added column whose default calls a function carries the rewrite warning unless the function is known IMMUTABLE or STABLE (a listed built-in, or a history routine every overload of which says so).
   - Looser: a retype that only widens, with no `USING`, is safe; `ENABLE TRIGGER` and its forms are cautious.
   - A Postgres baseline compares views, materialized views, sequences and policies as it compares functions and triggers, leaving out a partition's cloned trigger.
   - On libsql, a `_cf_` table is now the project's own (only D1 owns that prefix), so it appears in `diff`, `baseline` and `status`: a libsql project with `_cf_` tables sees new drift. Litestream's tables are left out on every engine.
   - `apply --file` on a file of the migrations directory refuses while a file before it is pending. A refused D1 or Turso apply or baseline writes nothing. A directory with no `.sql` file and no `atlas.sum` is an empty history; `.sql` files with no sum are refused, naming `comb migrate diff`.
   - `lockTimeout` takes Postgres's duration grammar (`250`, `1.5s`, `500us`, `1h`).

8. **Expect new answers from the error handlers.**
   - A D1 `exec()` error, which quotes the statement and its values, answers its generic cause, never a column or table read from that text.
   - A duplicate rowid, an FTS5 table's included, is a 409 `primary_key_violation`; a bound value that spells D1's "pattern too complex" is no longer a 400.
   - On Postgres, a violation reported on a partition is classified under the statement's own table, and a table no map knows names no column. A composite foreign key names no column. A driver's lost or refused connection (`ECONNREFUSED`, `ECONNRESET`, a pool or connect timeout, Bun's `ERR_POSTGRES_CONNECTION_*`, node-postgres's "Connection terminated unexpectedly") is a 503 `database_unavailable`, where it was unclassified.

9. **Remove what was removed, and know what was added.** `ensureMigrationsTable`, `checkMigrationHash` and `recordMigrationHash` are no longer exported from `/migrate`: comb's own apply creates and upgrades its history table. `withRetry` reads transience from an error's `status` or network `code`, never its message. `Connection.batch` states its contract per driver: one transaction on SQLite, libsql and bun:sqlite; on D1, its statements in order, with no rollback when one fails, so code that relied on a D1 batch being atomic must not. `fieldConstraintsOf` (`/codegen`) takes a required `measure`, `"length"` for a text column's bounds and `"value"` for a number's, which it reads its bounds by, and refuses any other. New exports: `IsoInstant`, `ListQuerySchema` and `RetrieveQuerySchema` (`/query`), `ListQueryInput` (`/query` and `/query/sqlite`), `ColumnKind`, `ListExtras` and `MergedListQueryResult` (`/query/sqlite`, the latter also from `/sqlite/d1/sharding`). (`TursoMissing` was listed here, but `/migrate` exports it from 0.17.)

10. **Give the shard router a `log`.** With none, `shard-router.kv.error` and `shard-router.revalidate.error` now go to `console.warn`, where they were dropped; pass `log` to route them, or `log: () => {}` to mute them. A KV read that fails trusts nothing in KV: the request reads the primary and caches in its own isolate only. `resolveVerified` writes and logs nothing when the primary names the shard it probed.

11. **The CLI.** `-h` and `--help` work at every level, `--version` prints comb's version, an option given twice is refused, and a bare `comb migrate` exits 1 with its usage. Under `--json`, a refused argv prints the JSON object too. `migrate diff` refuses a project with no drizzle config before drizzle-kit runs, and the approval prompt goes to stderr.

## Upgrading to 0.15

What changes for a project on 0.14.1. Before deploying it:

1. **Regenerate, then rewrite the imports of generated subpaths.** Every generated subpath of a table is its export's name in kebab case, camelCase and snake_case both, for its DTOs, rqb-cols and sql-cols and their directories alike. The DTOs of a camelCase export keep their path:

   ```diff
   - import { blogPostRqbCols } from "@app/db/rqb-cols/blogPost"
   - import { tableTemplateSqlCols } from "@app/db/sql-cols/table_template"
   - import { tableTemplateDtoReadSchema } from "@app/db/dtos/table_template"
   + import { blogPostRqbCols } from "@app/db/rqb-cols/blog-post"
   + import { tableTemplateSqlCols } from "@app/db/sql-cols/table-template"
   + import { tableTemplateDtoReadSchema } from "@app/db/dtos/table-template"
   ```

   Two tables whose names meet in kebab case (`blogPost` and `blog_post`) are a codegen error; rename one export. The rest of the diff changes no behavior: each entity stamp gains `partialUniqueIndexes`, each list query stamp `maxPatternBytes`, and the constraint map drops the enum CHECK entries of tables that apply no enum CHECK, which could never fire.

2. **Hand `paginate` the built query.** Every builder's result carries `pagination`, which holds the parsed query, the cursor options and the keyset in one, so `paginate` and `paginateMerged` take it in place of the parsed query and options:

   ```diff
   - const [items, page] = queryHelpers.paginate(rows, parsed, { cursorScope, cursorSecret })
   + const options = queryHelpers.listOptions(parsed, { cursorScope, cursorSecret })
   + const [items, page] = queryHelpers.paginate(rows, options)
   - const [items, page] = paginateMerged(rowsPerShard, parsed, { cursorScope, cursorSecret })
   + const [items, page] = paginateMerged(rowsPerShard, mergedListOptions(parsed, { cursorScope, cursorSecret }))
   ```

   The result of `buildListQuery` and `buildDerivedListQuery` is passed the same way. `buildDerivedListQuery` takes `anchor: { idColumn, table }` for rows of one table, where a sort value too long for a cursor is carried by reference, or `idColumn` and `idField` for rows of no one table; paginate's `keyset: "derived"` and `idField` are gone:

   ```diff
   - const built = buildDerivedListQuery({ ...sealed, idColumn: doc.id, parsed, sortColumns })
   - const [items, page] = queryHelpers.paginate(rows, parsed, { ...sealed, keyset: "derived" })
   + const built = buildDerivedListQuery({ ...sealed, anchor: { idColumn: doc.id, table: doc }, parsed, sortColumns })
   + const [items, page] = queryHelpers.paginate(rows, built)
   ```

   A list paged by hand, with no builder, takes its pagination from `queryHelpers.listOptions(parsed, options)` too. A parsed query the app writes itself, not one `schema.parse` returns, is passed with `sortOrderBy` beside `parsedSort`, and with `validated: true`, which says its sort and filter were checked; without it a sort is refused as a 500 `sort_not_wired`:

   ```diff
   - const [items, page] = queryHelpers.paginate(rows, { limit: 20, parsedSort: [{ direction: "desc", field: "created_at" }] }, sealed)
   + const parsed = {
   +   limit: 20,
   +   parsedSort: [{ direction: "desc", field: "created_at" }],
   +   sortOrderBy: { created_at: "desc" },
   +   validated: true,
   + } as const
   + const [items, page] = queryHelpers.paginate(rows, queryHelpers.listOptions(parsed, sealed))
   ```

   The call before 0.15 is refused as a 500 `page_not_wired` naming the built query, and so is a page of more rows than the query reads, one whose limit was not applied. A list ordered by a computed sort answers `nextCursor: null`, its next page by number still served. `applyListQuery` takes drizzle's select as it is, so `.$dynamic()` may go.

3. **Check the filters your clients send.**
   - A `like` or `ilike` value with a `*` inside it is capped at 50 bytes as SQLite reads the pattern, escaped (a `[` in a `like` is the three bytes `[[]`), and one past it is a 400 at validation that names its size. D1 refused it before only once it read a row. On a database without D1's cap, raise it: `validateFilter(filter, fields, { maxPatternBytes: 500 })`, or `limits: { maxPatternBytes: 500 }` on `createListQuerySchema`. A literal typed as a whole `FilterLimits` needs the new key.
   - An ISO date filter (`format: "iso"`) is the instant it names, typed as `toISOString()` text: `2024-01-01T01:00+01:00`, `2024-01-01T00:00Z` and `2024-01-01` (midnight UTC) are one instant. On a text column it compares with what the column stores, so a column that stores another spelling (`…T05:00:00Z`, or an offset) no longer matches `eq`, and its ranges shift, as `.` sorts before `Z`: rewrite stored ISO text to `toISOString()` form, or store the dates as epoch milliseconds. On a date or number column `filterToSQL` now binds it as the column stores it, where it answered `filter_not_wired`. Code that read the validated value back as the client wrote it gets the instant.
4. **Send canonical uuids to plain Postgres `uuid` columns.** A create or update DTO takes a `uuid` as `z.guid()`: braces and bare digits, which Postgres also takes, are a 400.
5. **Remove `multiTenant` and `promotionOrder` from `comb.migrate.config.ts`.** No command read either, so a config that set `multiTenant` migrated its one database and exited 0; it is now refused, naming the key, and `MultiTenantConfig` is no longer exported.
6. **Await `generateIncrementalMigration`**, which returns a Promise: it creates a non-public target schema on the dev database before Atlas replays there. A `readPgObjects` you pass to the CLI returns the new `LiveObjects`: `routines`, each routine by its name with its kind and each overload's input argument types (`signatures`), and `triggers`, each table's triggers by name with when and for what they fire (`type`, Postgres's `tgtype`) and whether they are `enabled`.
7. **Drop `d1Bookmark` from code that reads a `ShardMapping`.** It was the bookmark of whichever request filled the cache, and nothing read it; a mapping an older router left in KV is returned without it. The router's KV tombstone moves to `shard-inv:<orgId>`, and while one lives a mapping in KV is trusted only when tagged with its nonce. A 0.14.1 worker neither writes nor reads the new tombstone, so move or unplace no org until every worker sharing the KV runs 0.15; a tombstone 0.14.1 left blocks caching only until its TTL.
8. **Give the CLI's flags no value.** `--yes=false`, `--yes=no` and `--json=0` meant `--yes` and `--json`; they are now refused, so a script that meant to refuse should leave the flag out.
9. **Run `comb migrate check <db>` on every database.** More is rated: on Postgres, an added `serial`, identity or stored generated column (a rewrite), an inline `CHECK` or `REFERENCES` (a scan), an inline `PRIMARY KEY` nothing fills per row (unsafe), `SET GENERATED ALWAYS` and an identity added `ALWAYS` (cautious, as a deployed insert that writes the column then fails), `ALTER DOMAIN` as its column twin, and `VACUUM (FULL)`, a `REINDEX` that is not concurrent and `CLUSTER` (a lock), while a `serial NOT NULL` column is no longer unsafe; on SQLite, a rebuild that drops the table's triggers is unsafe; on D1, a dot-named file, files whose leading numbers order otherwise than their names, and a pending file ending inside a comment or without a final `;` are refused. Approve a file meant to do one with `-- comb:allow-unsafe: <reason>`.
10. **Expect baseline to compare more.** A SQLite baseline compares triggers, views and FTS tables; a Postgres one compares functions by their arguments and triggers by how they fire, and refuses an extra overload, other arguments, another timing or a disabled trigger. Adopting 0.12's shared history now needs proof, replayed on `devUrl`, so `devUrl` must reach its dev database.
11. **Check Postgres URLs that spell their server in the query.** `?port=`, `?dbname=`, `?host=` and `?user=` are read as libpq and Atlas read them where comb connects itself (baseline's live functions, the dev schema), so a URL that reached another server or failed there now reaches the one Atlas migrates; `sslmode`, `sslrootcert`, `sslcert` and `sslkey` set TLS as libpq does. An empty host is localhost over TCP, as Atlas's driver reads it; a socket is spelled `?host=/run/postgresql`, and one spelled as a percent-encoded host (`@%2Frun%2Fpostgresql`), which Atlas refuses, is refused before it runs. A password whose `%` escape is no UTF-8 is refused before Atlas runs.

### Migrate

- **Atlas's apply report is read one way** for a dry run and an apply: an apply that lost the lock to one that ran every file says "No migrations to apply", one that ran nothing while files are pending is refused naming them, a refused dry run shows the reason in Atlas's JSON, and a failed `-- atlas:txmode none` file says how many of its statements stay applied. Baseline's refusal and `migrate status` name the last applied version.
- **A file Atlas ran halfway** is no longer blamed for an earlier file's change: an earlier file edited, deleted or added since is named; a changed half-run file is told to restore it and fix what made its statement fail, as Atlas resumes it there.
- **A refused SQLite apply or baseline writes nothing**, comb's history table included, and **a retried apply runs a file once**: when a batch commits and its answer is lost, the retry finds the file recorded.
- **D1: a wrangler run that stops short reports what it applied**, recording the hashes of the checked files it ran; `--json` lists them in `applied`.
- **Postgres rating reads what Atlas sends**: a chunk's leading comments, a nested block comment among them, no longer hide a statement from the rating or a table it makes from the schema comb follows.
- **Secrets in Atlas's output are masked more exactly**: a socket target's password is masked, and a literal secret only where it stands as a token, so a password that is part of a table name leaves the name.
- **Postgres: a target schema that does not exist** is explained, with the `CREATE SCHEMA` to run once; comb creates a non-public schema on the dev database through the optional `postgres` peer.
- **Proof run**: a table renamed with a renamed column is named as renamed, and values a `DEFAULT` of now would exceed, and every nullable column left NULL, are seeded, so such tables are no longer left unproven.

### Query and errors

- **Merged paging**: a cursor page that ended on a null key no longer repeats rows from other shards, and two shards answering one id is `sort_not_wired`.
- **An anchored derived list sorted by an SQL expression** pages a long key by reference when the expression reads the anchor table's own columns alone; on any other expression a key too long for a cursor is a 500 on the page that meets it, never a cursor the next page refuses.
- **D1: a prefix or suffix filter binds its text once**, so the largest accepted request binds at most 80 parameters, as documented.
- **SQLite's "statement too long" is a query error**, not a 400; D1's pattern refusal is read from D1's own message, never a bound value; and D1's "Exceeded maximum DB size" is the 422 storage limit a full disk gets.
- **A time zone offset past 15:59 is a 400 `invalid_value`**, by every write path, and the `timetz` and `timestamptz` write DTOs refuse it first.
- **A read DTO takes a stored float's `Infinity` and `-Infinity`**, which JSON writes as `null`, and the `null` D1 hands one back as; its published schema takes that `null` (`anyOf: [{ type: number }, { type: null }]`); on Postgres a stored `NaN` still fails it, as JSON Schema cannot represent one.
- **Postgres: an expression unique index names no column**; `PgErrorRead.keyExpression` says the key held one.

### Codegen

- **Each `c.json` schema is imported under a name of its own**, so two modules' same-named schemas no longer collapse into one; one named as a generated file's own name is aliased.
- **Integer bounds that leave no integer fail codegen**, naming the column, and an integer's example stays inside fractional bounds.
- **`c.enum` takes `private`, `nomutate` and `tenant`** beside its state machine, and a misspelled machine key fails codegen naming the column.

### New

- `refoldStatements(table, column, sources)`, from `@lovrozagar/comb/query/sqlite`: the backfill of a `_search` column, writing only rows whose fold changed.
- `combDatabaseErrorKeys` and `CombDatabaseErrorKey`, from the package root: the keys the database classifiers answer with.
- `contains` runs on SQLite, as a member of the JSON array a column holds, a plain `text()` column's included; a scalar JSON value is no array, and matches nothing.
- The entity stamp's `partialUniqueIndexes` (meta-contract.md §6.8) and the query stamp's `maxPatternBytes`, optional facts within v1.
- `page_not_wired`, a new error key.

## 0.14.1

A fix with nothing to change: deploy it over 0.14.0, with no regenerate. The shard router's `invalidate` (and so `move` and `unplace`) leaves its KV tombstone under its own key, `shard:<orgId>:inv`, and deletes the mapping's key, `shard:<orgId>`. 0.14.0 put the tombstone in the mapping's key, where a 0.13.x router sharing the KV during a rolling deploy read it as a mapping with no shard. A tombstone 0.14.0 left there is still a miss, so 0.14.0 and 0.14.1 workers can share one KV namespace.

## Upgrading to 0.14

What changes for a project on 0.13.1. Before deploying it:

1. **Regenerate and review the diff.** Most of it changes no behavior: lines a machine's locale sorted otherwise are ordered by code unit; under `node16` or `nodenext` every relative import gains `.js` (`.ts` under `allowImportingTsExtensions`); each table's remaining inline schemas move into `_shared`; the generated `_shared` file imports `isStorableText` from comb in place of an inline regex; and `z.compile(…)` leaves every entity schema. Four kinds of change need a look:
   - **Relations of snake_case exports are renamed.** `blog_comment.blog_post_id → blog_post` gives `blogComments`, not `blogCommentsByBlogPost`, and `invited_by_blog_post_id` gives `invitedBy`. The code that names an old one fails to compile; rename it. A camelCase export's names are unchanged.
   - **A `pgSchema` table is named `schema.table`.** Its error keys start `auth_users_` (`users_email_duplicate` becomes `auth_users_email_duplicate`), and its published entity name and table-names entry are `auth.users`. Update translations and anything that keys by them.
   - **A constraint on a private column answers with its table's key.** `<table>_duplicate`, `<table>_reference_not_found`, `<table>_value_invalid` and `<table>_check_failed` replace keys that named the column; update translations that key by them. The regenerated constraint map lists the private columns (`private`), so no error names one; a hand-written map should add the list.
   - **A read DTO states a declared bound and no longer enforces it.** `maxLength`, `minLength`, `minimum` and `maximum` from `c.text`, an email, `c.id`, `c.integer`, `c.real` and `c.timestamp` (and a SQLite text length) move to `x-comb-maxLength`, `x-comb-minLength`, `x-comb-minimum` and `x-comb-maximum`, so a row stored past one parses. A client that validates responses against the published schema reads them under the new names.
2. **Expect codegen to refuse what it used to let through.** A `c.id` prefix `generateId` refuses (2–10 lowercase letters and digits, a letter first) fails the tables module as it loads, naming the file; its ids could never be generated. A constraint that is no finite number (`max: Number(process.env.NAME_MAX)`, NaN in codegen's env-free child) fails codegen naming the column. A plain Postgres column of a data type comb has no rule for (`sparsevec`) fails, naming the types comb does type. A tables module that read a file relative to its own folder now reads it relative to the config's directory, where the app and drizzle-kit load it; resolve a module-relative path from `import.meta.url`.
3. **Run `comb migrate check <db>` on every Postgres database.** Postgres DDL and writes are rated from the parse tree, so a pending file that relied on a spelling the text rules missed is re-rated, and the history's Atlas split, renamed or deleted applied files, and 0.12's shared history are checked as the Migrate list says. Approve a file that is meant to do what it is refused for with `-- comb:allow-unsafe: <reason>`.
4. **Record the hashes of D1 files applied before comb kept them.** `comb migrate status <db>` names them (`No hash recorded for …`), and comb cannot tell whether one was edited since. From the commit that applied them, once `git log` shows no edit to them since, run `comb migrate baseline <db> --hashes` once on each D1 database: it records each one's current text as the text that ran, which is the one thing it cannot verify. A tool that empties a D1 database keeps `d1HistoryTables(...)` from `@lovrozagar/comb/migrate`, rows and all, or an applied file edited after a wipe passes `check`.
5. **Install `postgres` (`>=3.4.9 <4`) where you baseline a Postgres database.** `comb migrate baseline` on Postgres now compares the database's functions, procedures and triggers with the history's by name, which Atlas OSS leaves out without a word: without the package it refuses, naming it, and a database holding one the history does not make, or lacking one it does, is refused ("the database's functions and triggers are not the ones the migrations leave, so baseline records nothing: …").
6. **Check every configured Postgres `schema`.** It must be a lowercase plain name (`^[a-z_][a-z0-9_$]*$`), at most 63 bytes and no reserved word: `Tenant`, which Postgres folds to `tenant`, `user` or `order` is refused with why. A `devUrl` that reaches the target database is refused however the two URLs spell it.
7. **Check what your clients send to list endpoints.** `filter` is capped at 4608 bytes (was 5120), `order` at 200 and `select` at 500 (new), and every character a form or a URL escapes, a space and `~ ! ' ( )` among them, counts 3 bytes; a request past a cap is a 400 field error ("At most N bytes as a URL or a form encodes it, …"). `page` and `limit` take decimal digits only: `0x10` or `1e3` is a 400, and a page that is no whole number from 1 throws `invalid_page` (400) from `parse` as from `paginate`. A handler that builds its parsed object with `validated: true` no longer skips the page bound: mark `pageBounded: true` where its own schema bounds the page.
8. **Check what your clients write to plain Postgres columns.** Create and update DTOs take what Postgres takes for the type, so a value Postgres would refuse is a 400 from the DTO, not a 22P02 from the insert, and these spellings Postgres also takes are refused for the canonical one: a date's `today`, `tomorrow` or `infinity`, a year past 9999 or BC; a time of `24:00:00` or a leap second's `23:59:60`; a `timestamp` at `T24:00:00`, or with an offset or Z (Postgres drops it, losing the instant) and a `timestamptz` without one (its instant would follow the server's TimeZone); a numeric with more fraction digits than its scale, an exponent, a leading `+`, `.5`, `5.`, `NaN` or `Infinity`; a bigint string with a leading `+`; an abbreviated network (`10.1`) in an `inet` or `cidr`; an interval not in ISO 8601's duration form (`1 day`, `P-1D`, `P1.5Y`); and a `varchar(n)` value past n by trailing blanks, which Postgres cuts.
9. **Before deploying the shard router, run `SELECT max(length(org_id)) FROM shard_map` on the core database.** It must be at most 64: `place`, `move` and `allocate` throw a `RangeError` past it, and `resolve` answers a longer id as a miss.
10. **Plan the full-text rebuild and the search refold.** The next `comb migrate diff` rewrites every generated FTS5 index under the new tokenizer (`unicode61 remove_diacritics 2 categories 'L* N* Co M*'`): it drops each group's triggers and index, creates them again and rebuilds from the content table, which takes time and, on D1, a row write per row. Apply rates it cautious, naming the rebuild. Refold every `_search` column (and folded FTS index) with `searchText(...)`, since `searchText` now drops Hebrew and Arabic marks and the tatweel, and a row written before keeps them until it is written again.
11. **On SQLite, check lists that filter on a relation's negation.** `tags.slug.ne.red` is a post not tagged red (an untagged one included), where it was a post with any tag that is not red; `nin`, `is.null` (no related row with a value) and `is.notnull` likewise. A list that meant the old reading filters with the positive and a `baseWhere` of its own.

### Migrate

- **Postgres DDL is rated from its parse tree.** No spelling the parser accepts (a quoted name with no space after it, `users*`, a `U&"…"` name) hides a dropped column, a retype, `SET NOT NULL`, a rename or a drop; an `ALTER TABLE` subtype comb does not list is unsafe and named. `SET TABLESPACE`, `SET ACCESS METHOD`, `SET LOGGED` and `SET UNLOGGED` warn that they rewrite the table under an exclusive lock.
- **Names resolve as Postgres resolves them under a schema other than public.** An unqualified name and `<schema>.name` are one name, and `public.name` another, so a trigger, rule, default or check the history wrote one way fires on a write the other way. 0.13.1's limit (write every name one way) is lifted.
- **What a write runs is followed further.** A write through a view is a write to its base table; a domain's CHECK, an inheritance parent's defaults and checks, every policy, and an event trigger reach the writes they run on; `session_replication_role` is unsafe; a function only `pg_catalog.` qualifies is a built-in (`public.lower(x)` is unsafe); and a default that calls `nextval`, as a serial does, no longer makes every insert unsafe.
- **A Postgres file is read as Atlas splits it and Postgres runs it**, `-- atlas:delimiter` included: a `BEGIN ATOMIC` function or a rule's action list stays one statement, and a history statement the parser cannot read fails ("comb could not read 1_a.sql: …"), where it was skipped. `splitSqlStatements(sql, "postgres")`, `extractSchema` and `exportDrizzleSchema` on Postgres need `loadPostgresParser()` first.
- **Applied Postgres files are matched to Atlas's revisions by version.** One renamed under its version is refused ("… was applied as … and is now …; restore its name"), and one deleted or renamed to another version is named and refuses `check` and `apply`. A schema 0.12 recorded in the shared `atlas_schema_revisions` is adopted into its own history when its rows are a whole, in-order prefix of the files ("Adopted from 0.12's shared history: …"); `public` ignores another schema's rows there, saying so. `baseline` records a file named by its version alone (`3.sql`) under the version Atlas reads.
- **More Postgres changes are rated.** `ADD PRIMARY KEY`, `ADD UNIQUE` and `ADD EXCLUDE` without `USING INDEX` warn that they lock the table; `SET EXPRESSION`, every sequence `RESTART` and `REPLICA IDENTITY NOTHING` are cautious; `ALTER DOMAIN … RENAME TO` and `SET SCHEMA` are unsafe.
- **An applied file edited inside a string literal is refused** on SQLite, libsql and D1, where the pre-0.5.0 hash let it pass; that hash now matches only a record from before 0.5.0. A pending SQLite file holding the text of one applied with `--file` is refused, naming both.
- **What Atlas says as it succeeds is a warning** (`Warning: Atlas: …`) from `diff` and `baseline`, where comb dropped it.
- **`status` on Postgres refuses a database with objects and no history**, as `apply` does.
- **A D1 `apply` starts 6 wrangler processes, where it started 11, and `status` 2**: comb reads its history in one `wrangler d1 execute`.

### Query

- **A list's anchor row deleted between pages repeats rows rather than skipping them.** On SQLite a null-keyed anchor resumes from the earliest value its null may stand for; pass `nonFinite: "exact"` beside `cursorSecret` on a driver that reads ±Infinity back as Infinity (a local libsql file, bun:sqlite) to resume right after it. On Postgres under a collation not by code point, a long anchor renamed or deleted answers `invalid_cursor` (400): pass `listOptions`'s result to `findMany` whole, `extras` included.
- **Keys page exactly where they did not.** An integer key past 2^53 pages every row once (a tiebreak id past 2^53 is `sort_not_wired`); a Postgres timestamp finer than milliseconds seeks by the column, so an index serves every page; a key holding ±infinity pages every row once.
- **D1 search and `like` take long values.** A search term over 50 bytes and a `like` whose only `*` are at its ends no longer fail with "LIKE or GLOB pattern too complex"; a pattern with a `*` inside it past D1's cap is a 400 naming the 50 bytes.
- **Filters bind as their columns compare.** A SQLite date `in` and `nin` bind in the column's unit, text on a date or number column is `filter_not_wired`, and a number on a `numeric()` column compares as a number.
- **Errors name the right thing.** A violation on a table or column whose name holds `, ` names it right; on SQLite an `UPDATE` in any case that breaks the row's own key is that key's error; a Postgres violation in another schema finds `schema.table`'s entry; and no error names a private column.
- **`createCursor` mints as `paginate` does**, a long value by reference.

### Sharding

- **The router keeps working when KV fails**, reading a failed call as a miss or a skipped write (`shard-router.kv.error`), and skips a KV put older than what KV holds.
- **`new ShardRouter(config)` refuses** a `totalShards` or `maxOrgsPerShard` that is no positive integer and a `kvTtlSeconds` under 60, KV's floor.
- **`shard-router.allocate` is logged once per row written**, and `resolve` answers an id longer than 64 characters as a miss.

### New

- `paginateMerged(rowsPerShard, parsed, options)` and `mergedListOptions(parsed, options)`, from the sharding entry, page a list merged from several shards by number or by cursor as one database would, its count summed.
- `move({ orgId, shardId, with })` batches your own core-database statements with the mapping's write; `ShardMove` is its type.
- `isStorableText(s)`, `storableText()` and `STORABLE_TEXT_RULE`, from the package root, hold an app's own text to the rule generated DTOs hold it to; `isCidr` is there too.
- `d1HistoryTables(migrationsTable?)`, `D1_MIGRATIONS_TABLE`, `D1_HASH_TABLE` and `DRIZZLE_HISTORY_TABLE`, from `@lovrozagar/comb/migrate`.
- `comb migrate baseline <db> --hashes` on D1.
- `c.ref(name, { relation })` names a key's relation, where a key whose role is a column's own name failed codegen.
- A constraint map's table may list `referenced` and `private`; a manifest relation carries a composite key's `key`; `generateSchemaDiff` and `generateIncrementalMigration` return Atlas's `notices`.
- A Node or Bun app that wants compiled parsing adds `import "zod/compile"` as the first import of its entry (zod 4.5.4 or later): comb's schemas are plain Zod, as a Worker refuses the code a compiled one builds.
- The CLI is tested on macOS beside Linux.

## Upgrading to 0.13.1

What changes for a project on 0.13.0. Before deploying it:

1. **Run `comb migrate check <db>` on every database.** A few SQLite writes 0.13.0 passed are refused again, as 0.12 refused them; the Migrate list says which. Approve a file that is meant to do one with `-- comb:allow-unsafe: <reason>`.
2. **Regenerate and review the diff.** Postgres tables with an index, a composite foreign key, an array column or a CHECK that spreads the generated enum CHECKs now generate, and generate right; every written text field publishes its guard as `x-comb-text` instead of a pattern. What a DTO accepts changes only where the Codegen list says.
3. **Give a tables module that read a `.env` its values another way.** Under bun, codegen no longer loads a dotenv file beside the tables module, so a variable it read at import from `.env` or `.env.local` is now unset there; a tables module should need none.
4. **A Postgres schema other than `public` migrated under 0.12:** apply its pending files with 0.12 first, then run `comb migrate baseline <db>` under 0.13.1. `baseline` marks every file applied without running it, so a file still pending at that point never runs.

### Migrate

- **`check` and `apply` never run a statement that reaches outside the database.** `ATTACH`, `DETACH`, `VACUUM INTO` and `load_extension()` are refused before they run, and no `-- comb:allow-unsafe` overrides it.
- **A `REPLACE` on a table that was there before the file is unsafe**, as in 0.12: `UPDATE OR REPLACE`, `REPLACE INTO`, `INSERT OR REPLACE`, and any write to a table declared `ON CONFLICT REPLACE` delete the rows they meet. An idempotent `INSERT OR REPLACE` seed of an existing table now needs an in-file approval, or `--yes` refuses it.
- **An FTS5 command is read in every spelling**: written `INSERT OR <conflict> INTO`, `REPLACE INTO` or after a `WITH`, `'delete'` and `'delete-all'` are unsafe as they are written plainly.
- **A trigger counts as an FTS sync trigger only when every statement writes a row's own values, or the `'delete'` command, into an external FTS5 table.** One that runs `'delete-all'` or another command is a trigger like any other, so a write that fires it is unsafe.
- **A renamed Postgres schema** (`ALTER SCHEMA … RENAME TO`) keeps the triggers, routines, domains, operators and casts the history named under it, so a later write under the new name that fires one is unsafe, as in 0.12.
- **Known limit, fixed in 0.14:** under a configured Postgres schema other than `public`, comb keys an unqualified table name as `public`'s, while Postgres resolves it in the configured schema. Until 0.14, write every table name the same way across the history and later files: always unqualified, or always qualified with the configured schema. A file that mixes both can be rated as touching a different table.

### Query

- **A cursor on a seconds-mode SQLite timestamp, or a date-mode Postgres timestamp, is bounded by the value it was minted from**, as in 0.12. The row is read only for what its `Date` cannot hold: a fraction below the millisecond on SQLite, and ±infinity on Postgres, which node-postgres reads as local 2000-01-01. An anchor edited between pages, or deleted and its id given out again, resumes where its old value stood.
- **On SQLite, libsql and D1, an `UPDATE` that sets none of the foreign key columns a constraint map lists** answers the neutral "Referenced record does not exist or is still in use", as 0.12 did, never "still referenced": a map need not list every key. A `DELETE` still answers "still referenced", and an `UPDATE` of a listed key still names its entry.

### Codegen

- **The loader runs the tables module and nothing else.** Under bun it loads no dotenv file (`--no-env-file`), so a `.env`, a `.env.local` or a `bunfig.toml` preload beside it sees none of its variables. It follows only the imports a module makes as it loads (import and export declarations, and a CommonJS file's top-level `require` calls), so a seeder imported with `import()` or required inside a function no longer runs. Under node, a TypeScript file loads in the format node itself gives it: a `.cts` file, one of a `"type": "commonjs"` package, or one of a package with no type and no module syntax loads as CommonJS, so `__dirname` and `require` work.
- **The loader is bounded.** Its child exits once its snapshot is written, so a timer or a pool the module keeps open no longer holds codegen. Each tables module loads in a process group of its own under a supervisor, which kills the whole group, every process the module started included, on the 60-second timeout, when the child exits, or when codegen is interrupted; a timeout says `comb timed out after N s loading <file>`. The CLI is tested on Linux and relies on POSIX process groups; Windows is not supported.
- **Postgres tables read their third argument by column.** `index()`, `uniqueIndex()`, `unique().on()`, `foreignKey()` and a composite `primaryKey()` are read as on SQLite (drizzle's pg-core passes stand-in columns), so codegen no longer fails on any Postgres table with an index, and a composite key's columns are required on create and out of update. **Behavior change on SQLite:** a key, index or unique in a table's third argument that names another table's column now fails codegen, naming the table; 0.13.0 wrote it as SQL.
- **A composite foreign key joins on every column pair.** Its relation is `from: [r.grant.orgId, r.grant.userId], to: [r.member.orgId, r.member.userId]`, named for the table it references, so `with:` serves the row the whole key references; its way back is `one()` only when the key's columns are unique together on their table, else `many()`. The constraint map lists each column, each is out of the update DTO, and the diagram DDL writes one table-level `FOREIGN KEY`. `ForeignKeyRef` gains `key?: { columns; refColumns }`, an additive type change.
- **A Postgres array column is an array of its element.** A write takes exactly its declared dimensions, each element nullable as Postgres stores it, and refuses a ragged multidimensional value Postgres refuses; a read takes any depth up to Postgres's six, as Postgres keeps no declared dimensions, so no stored row is refused. `FieldMeta` gains an optional `dimensions`, an additive type change.
- **Applied enum CHECKs map once.** A table that spreads the generated `…EnumChecks(t)` regenerates: a CHECK under comb's enum name that checks what comb writes is comb's, mapped once as `_enum_invalid`. One under that name that checks something else fails, saying so; two CHECKs of one name fail as such.
- **The text guard is a refine, published as `x-comb-text`, never a pattern.** Go's and Rust's validators compile every pattern comb writes itself, under RE2's syntax, with no lookaround and no backreference, and a declared pattern too, which codegen holds to that syntax, and each means the same rule there as in ECMAScript: every class is written out, as `[0-9]` or `[^\n\r]`, never `\d`, `\w`, `\s`, `\b` or `.`, which those engines read as other sets, and codegen refuses a declared pattern holding one, a lookaround, a backreference or a `\0`, which Rust reads as an octal escape and refuses; every pattern compiles under `u`, as JSON Schema reads it; a field's own `pattern` stays its `pattern`, with no `allOf`; a written `c.json` field is its schema's `$ref`, its own description kept, with `x-comb-text` and `x-comb-maxBytes` beside it. A JSON field's rules leave its description. A reference under the id rule, and a written `c.id`, take the guard after the id rule, 1 to 48 characters none of which is an ECMAScript blank (its WhiteSpace and LineTerminator, each written out in the pattern), so U+0000 and a lone surrogate are refused there too.

## Upgrading to 0.13

What changes for a project on 0.12. Before deploying it:

1. **Run `comb migrate check <db>` on every database first.** The proof now rates each pending SQLite file by what SQLite itself does, and each Postgres file by Postgres's own parser, so a pending file 0.12 passed can be refused. Read each reason, and approve a file that is meant to do it with `-- comb:allow-unsafe: <reason>`; applied files are never re-rated.
2. **Install `libpg-query` (`>=17.7.4 <18`) where comb migrates Postgres.**
3. **Make every tables module import-safe.** Codegen now runs it, in a child process with only `PATH`, `HOME` and `NODE_OPTIONS`: no connection, secret or work at import, as drizzle-kit already requires.
4. **Regenerate and review the diff.** DTO rules, relation names and shared schema names change where 0.12 read the source wrong; every change is listed under Codegen below. Update each `with:` that names a renamed relation.
5. **Refold every `_search` column** with `searchText(...)`, as the Cyrillic change below says.

### Migrate

- **SQLite writes are rated by SQLite itself.** On bun:sqlite, libsql and D1 the proof reads each statement's writes with `EXPLAIN` instead of reading its text, so no spelling hides one. A delete of existing rows, a `REPLACE` over one, an update of a column the table had, and a write that fires a trigger on an existing table stay unsafe, and the reason now names the table, the columns or the trigger. A write to a table the same file created is safe, not cautious. A second write to a column the same file added is cautious, not unsafe.
- **`classifyMigration()` on SQLite, without the proof run, holds writes for the engine.** It clears only what text can show: any write to a table the file created, a backfill of only the columns the file added (cautious, once), and an insert no history trigger watches that replaces nothing. Every other write is unsafe, "pending the proof run's read of what it writes", and listed in the new `MigrationClassification.pendingStatements`. `comb migrate check` and `apply` run the proof, whose findings replace those entries, so their ratings are the engine's.
- **A file the proof copy cannot run is unsafe**, with the statement and SQLite's error, and so is every pending file after it. In 0.12 such a file kept the classifier's rating. A file that fails only on the copy (a constraint a seeded row breaks) needs `-- comb:allow-unsafe: <reason>`.
- **An FTS5 `'delete'` or `'delete-all'` command is unsafe**, as is a command comb cannot read. `'rebuild'`, `'optimize'`, `'merge'` and the option settings stay safe.
- **Postgres migrations are read with Postgres's own parser.** Install the optional peer `libpg-query` (`>=17.7.4 <18`) to migrate Postgres. comb's CLI loads it itself; a program that calls `classifyMigration()`, `parseMigration()` or `extractDropStatements()` on Postgres awaits `loadPostgresParser()` from `@lovrozagar/comb/migrate` first.
- **Each row of comb's SQLite history records one file.** A row recorded with a name matches the file of that name; a row from before 0.11, unnamed, matches one file by its hash, among the files no named row holds, and is named on the next apply. A row that matches no file (one edited or renamed after it was applied) refuses `check` and `apply` and is named in `status`. A new file whose text matches an applied one (an index dropped, then made again) is pending and runs. The first `apply` or `baseline` rebuilds `__drizzle_migrations` once, in one batch, so the file's name, not its hash, is unique; every row and id is kept.
- **A history 0.12 left is read as 0.13 names it.** 0.12 recorded a `--file` by its base name wherever the file was, so the first 0.13 `apply` (and `check` and `status`, read-only, before it) resolves each named row once: a row whose name a top-level file has keeps it; one whose hash exactly one unrecorded file has takes that file's name, so a file renamed under 0.12 is not applied again; any other is recorded as `../<name>`, a file from outside the directory, as 0.13 names one. A file deleted under 0.12 reads so too: 0.12 could not tell a deleted file from one applied with `--file` either. A hash two unrecorded files hold is refused, naming them. Every row 0.13 records stays strict. The rebuild also keeps the history's AUTOINCREMENT counter, so no id is handed out twice, and takes any view or trigger over the history with it, recreated in the same batch; one that cannot come back is named, and nothing changes. `--file` refuses a file in a subdirectory of the migrations directory, which a whole-directory run does not read.
- **An applied file edited since is refused on Postgres and D1 too**, in `status`, `check` and `apply`, as on SQLite; on Postgres it was a status warning. D1's `migrations_table` records names only, so comb records the hash each file was applied under in its own table, `_comb_migration_hashes`. For a file applied before 0.13, `status` says comb has no hash to compare.
- **A Postgres schema other than `public` keeps its own history**, in `atlas_schema_revisions_<schema>`; in 0.12 every schema of a database shared `atlas_schema_revisions`, so an apply to one schema marked another's files applied. A schema migrated under 0.12 now has tables and no history of its own, so `apply` and `check` refuse it as Atlas does any database with objects and no history; apply its pending files with 0.12 first, then run `comb migrate baseline <db>` under 0.13 to record them: `baseline` marks every file applied without running it, so a file still pending when you baseline never runs. `public` keeps `atlas_schema_revisions`.
- **A config key comb does not know is refused at load**, at every level, rather than dropped for its default: a misspelled `local` on a D1 provider no longer targets the remote database. `-e` on a database that declares no environments is refused, and `-e constructor` names no environment.
- **A guarded rebuild whose guard would fire a trigger is unsafe.** `migrate diff` refuses to guard a rebuild whose guard empties a table with a trigger other than an FTS sync one; a trigger a later file put there after the guard was written is now caught too: `check` and `apply` rate the rebuild unsafe, naming the trigger, and the proof counts a trigger the guard's statements fire.
- **The proof names a rename.** A column or table whose every value a new one holds, row for row, is reported as `renames users.email to users.mail` or `renames users to accounts`, still unsafe, rather than as a loss.
- **A libsql URL's `file:` scheme is read in any case**, so `check` and `status` refuse a missing `FILE:` database, as they do a `file:` one, and create none.
- **D1 refuses what SQLite refuses, and creates no local database to check.** An applied file renamed or deleted since is refused in `check` and `apply` and named in `status`, as on SQLite; a renamed one no longer runs again. When `wrangler d1 migrations apply` fails partway, the files it applied keep their hash. `check` and `status --local` first look for the local database where wrangler 4 keeps it (`.wrangler/state/v3/d1` beside the wrangler config, named from the binding's `preview_database_id`, else its `database_id`, else the binding); where there is none, they refuse rather than let wrangler create one.
- **Names fold as SQLite folds them: ASCII letters only.** `"Über"` and `"über"` are two tables and `"Users"` and `"users"` one, in the classifier, the proof and the rebuild guard alike, so a table named with a non-ASCII capital is probed as itself and a rebuild of a mixed-case table closes as any other. An unquoted Postgres name folds the same way, as Postgres folds one in UTF-8.
- **`ALTER TABLE … DISABLE TRIGGER ALL` and `SET UNLOGGED` are unsafe on Postgres.** `ALL` takes the triggers that enforce the table's foreign keys with it; an unlogged table is emptied after a crash and not replicated. `DISABLE TRIGGER USER` or a named trigger stays cautious, and `SET LOGGED`, which rewrites the table, is cautious.
- **A Postgres URL's `search_path` must name the configured `schema`.** One that lists several schemas, or another one, is refused in every command, `check` and `status` included, before Atlas runs, rather than replacing `schema` or failing inside Atlas.
- **An unnamed dialect is SQLite.** `classifyMigration()`, `parseMigration()` and `extractDropStatements()` with no `dialect` read the file as SQLite, the CLI's default; 0.12 read it both ways and kept the stricter. Name `dialect: "postgres"` for a Postgres file.
- **A Postgres history is read from its parse trees.** Its triggers, its tables' renames and moves to another schema, and every function, procedure, aggregate and operator a migration defined are read from Postgres's own parse of each file, so a Unicode-escaped name, `ALTER TABLE IF EXISTS … RENAME`, `SET SCHEMA`, a renamed function or a dropped overload no longer hides one. A name a migration ever defined stays defined, and a bare call or operator matches it in any schema, as the search path may hold that schema. `SET ROLE` and `SET SESSION AUTHORIZATION`, and their `RESET`, are unsafe, as `SET search_path` is: they change what `"$user"` puts on the search path. `ExtractedSchema.functions` is gone; its `triggers` lists SQLite's only.
- **`nextval` is cautious and `current_setting` unsafe.** A sequence `nextval` advances stays advanced when the apply fails, and `current_setting` copies a setting, an application's secret among them, into rows. More pure built-ins rate as such: the window functions (`row_number`, `rank`, `lag` and the rest), `position`, `overlay`, the `regexp_` and `sha` families, `ln`, `log`, `exp`, `pi`, `div`, array and JSON-path functions, `date_bin` and `to_regclass`, so a backfill with them is cautious, not unsafe.
- **Postgres ratings that change.** A `DO` block, a `CREATE FUNCTION`, `PROCEDURE` or `TRIGGER`, a `CALL`, and a call of a function that is not a pure built-in are unsafe; in 0.12 a routine was rated by its body and a call of an earlier file's routine was cautious. `dblink` is unsafe, not cautious. A `DO` body is no longer read, so a drop inside one is not listed among the drops. A statement Postgres cannot parse is unsafe. Each such file needs `-- comb:allow-unsafe: <reason>`.

### Query, lists and cursors

- **New key: `INVALID_PAGE` (`invalid_page`).** An exhaustive `Record<CombErrorKey, …>` map, such as a table of translations, needs an `invalid_page` entry.
- **A cursor's reference carries the value's length.** A long sort value goes by reference with its prefix and its length in code points, and the keyset reads it from the row only while the row keeps both, so a renamed anchor resumes where its old value stood instead of restarting or ending the list. A reference minted by 0.12 is `invalid_cursor`, and the client starts the list again. A reference no longer binds more parameters than the value would, so a three-key cursor keeps within the 10 the D1 budget allows it. A deleted anchor on a nullable Postgres column under a collation not by code point ends the list instead of skipping to the NULLs. On D1, a REAL holding ±Infinity pages as itself.
- **A date-mode Postgres `timestamp` holding `'infinity'` pages exactly.** It looped: node-postgres reads both infinities as 2000-01-01, and the cursor carried that Date. The cursor's bound is now read from its row; a `timestamptz` or `date` holding one is still the documented 500, its message naming both dialects' causes.
- **FTS can fold its terms as `_search` was folded.** An FTS source takes `folded: true` when its table indexes a `searchText` column, and each term is folded with `searchText` before the match, so FTS over `_search` finds what `likeSearch` does; the README's Search section lists the folds `unicode61` does not make.
- **`@noble/ciphers` and `@noble/hashes` take 2.0.0 and up.** comb's calls (`xchacha20poly1305`, `hkdf`, `sha256`) are the same from 2.0.0, so an app that pins noble 2.0 to 2.3 through the scure packages shares one copy; the repo's suites run at that floor.
- **`CursorRef` and `CursorValue` are exported** from `@lovrozagar/comb/query`, so code that reads a cursor with `readCursor` can tell a value carried by reference, which a keyset must read from the cursor's row, never bind. `readCursor` checks its options first, so a handler that cannot seal answers a long cursor with `cursor_not_wired` too.
- **SQLite names with a dot or a dash** split right in errors: a STRICT mismatch on `line-item` names its table and column, and a dotted pair splits at the statement's own table.
- **A sealed cursor's length says nothing of its values.** Its plaintext is padded to a multiple of 256 bytes before sealing, so cursors whose values differ in length within one bucket are one length; a cursor is up to about 340 characters longer. 0.12 cursors still open.
- **A seconds-mode SQLite timestamp holding a fraction pages exactly.** A cursor's bound on such a key is read from its own row, any fraction kept, as no Date holds one below a millisecond; drizzle would floor a bound Date to the second. Once that row is deleted the cursor's milliseconds bound it, so a row of that millisecond may come again and none is skipped. A `buildDerivedListQuery` list has no row to read, so on a seconds-mode key it pages exactly only for values whose fraction is whole milliseconds.
- **`searchText` drops a stress mark after a Cyrillic letter.** It kept every mark after one; now it keeps only those NFC puts back into a letter of its own (й, ї, ё, ў), so a stored `доро́га` matches a typed `дорога` in `likeSearch`, as FTS5 finds it. Refold every `_search` column with `searchText(...)` after upgrading.
- **The request byte caps are published.** `x-comb` stamps `maxFilterBytes` (4608), `maxSearchBytes` (600) and `maxQueryBytes` (14336), and the `filter` and `q` descriptions name them, so a client building requests from the schema knows a `filter` within its 2048 characters may still be refused once percent-encoded.
- **A foreign key error names the right side.** On SQLite, an `UPDATE` that leaves its table's own key column alone, as one of a referenced key does, is answered as still referenced, as a `DELETE` is, instead of with the table's own key's entry. On Postgres, a schema-qualified table is named by its table in the still-referenced error, not by its schema.
- **A page no schema validated is a whole number from 1, in both builders.** `buildListQuery` and `queryHelpers.listOptions` refuse page 0, a negative page or a fraction with the new key `invalid_page`, a 400, and a page past 10 000 with `page_too_deep`; `listOptions` bounded no page before.
- **A page past `maxPage` is `page_too_deep` on every list.** A schema-built list answered it with a validation issue on `page`, while a list no schema bounded answered `page_too_deep`. `createListQuerySchema` now throws `CombError` `page_too_deep` (400) from `parse`, `safeParse` and `~standard.validate`, so map `CombError` in your error handler; the param's `maximum` is still published.
- **`validateFilter` types a runtime field map.** A field may be a spec, `{ type, operators?, format? }`: its own operator set, `contains` (typed as one scalar of the field's type), ordered comparison on a string, and `format: "iso"` for a date stored as ISO 8601 text. `parseFilterNumber` exports the number rule, which refuses `0x`, `0b` and `0o` spellings and integers past ±(2^53 − 1). A field given as a bare type checks as before.

### Sharding

- **`ShardRouter` places orgs as the app decides.** `pick({ orgId, counts, totalShards })` names a new org's shard (the default keeps the headroom rule, and `maxOrgsPerShard` is documented as a soft cap); `place`, `move` and `unplace` write a mapping yourself; `resolveVerified` checks the org's rows are on its cached shard and rereads the primary when not. A replica miss now rereads the primary, and a primary miss is remembered for `missTtlMs` (5 s).

### Codegen

- **Codegen loads the tables module instead of reading its source.** Each table is read as drizzle built it (`getTableConfig`) and with the constraints, enum values, machine, schema and id prefix the `c` helpers now record on the column, so a value is what the module computes however it is spelled: a const, an enum member, a spread, a constraint object by name, a `paths` alias, a namespace or default import, a block body, two tables in one statement, a columns const, a re-export through a local binding, `pgSchema(...).table` and `pgTable.withRLS`, and a key through an import alias all read as they run. The module runs in a child process with only `PATH`, `HOME` and `NODE_OPTIONS` and 60 seconds to load, so it must be import-safe, as drizzle-kit needs it to be. A load error, a column of a type comb cannot type (a buffer blob, a bigint, a date mode), a `c.json` schema no module exports (export an inline one), and a key into a table the tables file does not export fail codegen, naming the file, the table and the column.
- **What the DTOs take changes where the source reading was wrong.** A plain drizzle column is typed from its data type (a `varchar`'s length, a `uuid` key's default, a `pgEnum`'s values) instead of `z.unknown()`. A composite primary key's columns are required on create and out of update. An identity key and a `generatedAlwaysAs` column are out of the write DTOs and listed as `generated`. An unnamed `unique()` maps under drizzle's own name for it, and a unique index on an expression under its index name. `.$type<z.infer<typeof X>>()` is a type, which the loaded module never holds, so such a column is typed by its helper; use `c.enum` or `c.json`. Regenerate and review the diff.
- **The codegen API follows.** `validateTables(analysis)` takes the `AnalysisResult` that `analyze(tablesPath)` returns. `parseFieldConstraints(raw)` is gone; `fieldConstraintsOf(record, { fieldName, filled, place })` checks a constraint record. `FieldMeta.raw` and `enumName` are gone; `combKind`, `columnType`, `dataType`, `sqlType`, `hasDefault`, `generated`, `identity`, `inCompositeKey`, `onUpdate`, `autoIncrement`, `prefix` and `unique` say what the generators read. `TableMeta` gains `expressionIndexes` and `schema`.
- **The DTOs refuse what no engine stores as sent.** Every written text field takes the pattern `/^[^\u0000\uD800-\uDFFF]*$/u` and every JSON field a refine for the same, on SQLite as on Postgres: Postgres refuses U+0000 and jsonb a lone surrogate, a lone surrogate reaches Postgres text as U+FFFD, libsql cuts a value at U+0000, bun:sqlite reads a lone surrogate back as other text, and SQLite's text functions stop at U+0000. Regenerating adds the `.regex` to each such field.
- **A column takes what it declares.** A `c.ref` that names a non-id column takes its own text rules (`max`, `pattern`, the rule above), not the id's. A `password` takes its declared `min`, `max` (at most 72) and `pattern` on top of its own rule, an `email` its `pattern` after the format. A `pattern` takes the `u` flag at most: JSON Schema compiles it under `u`, where a `v` source does not compile.
- **A timestamp the shared spread would get wrong is its own field.** The read DTO takes a timestamp from the spread only when it is comb's helper of that name, not private, and of the spread's nullability; a private `deletedAt` is no longer read back or published as `softDelete`, and a nullable `updatedAt` reads as nullable.
- **Codegen refuses output two writers share.** A path another database's record lists (a run of some databases no longer overwrites it, or deletes it as stale), and two generators of one database configured onto one path each fail, naming both.
- **Relations keep their names, or codegen says why.** A relation's way back is named by the role its one side has: `author_id` gives `author` and `postsByAuthor` (0.12 wrote `postsByAuthorId`), `invited_by_user_id` toward `user` gives `invitedBy` and `postsByInvitedBy`. A relation whose name a column of its table holds fails codegen, naming both, instead of becoming `<name>Relation`, so adding a column never renames a relation code uses. Rename the column, or the key's column. A url column's published schema keeps `format: "uri"` beside its https pattern.
- **Smaller codegen fixes.** A Postgres column's unnamed `.unique()` is published under the name Postgres gives it, `<table>_<column>_key`, cut as Postgres cuts a name past 63 bytes; Postgres numbers a name it already holds (`_key1`), which only the database knows, and which happens only when two such names cut to the same text. Shared DTO schemas are named by their own code (`_z_<8 hex>`), so a column added to one table rewrites no other table's file. A CHECK or enum error key's message says what the value broke, never to try again. A table a column named `__proto__` broke, a header of another tool named like comb, `-g` for a generator no database runs, and a broken 0.9 record each fail, naming it; a database named twice runs once; a stale file that cannot be deleted stays in the record. An email, url or image example its column's `min` refuses is left out. `c.timestamp` takes `min` and `max`. The diagram SQL renders a composite key and says it outlines the schema.

## Upgrading to 0.12

0.12 makes the cursor seal's two packages peers. It is a breaking minor; what changes for a project on 0.11:

**Install** `@noble/ciphers` and `@noble/hashes` (`>=2.4.0 <3`) beside comb. From 0.12 they are required peers, which seal and key the cursors, so the app and comb share one copy.

## Upgrading to 0.11

0.11 closes the findings of a fresh review of 0.10. It is a breaking minor; what changes for a project on 0.10:

**Migrations**

- **Ratings are default-deny.** comb rates only the statement shapes it recognizes (tables, indexes, views, virtual tables, schemas, sequences, types, domains, extensions, comments, `ALTER TABLE` actions it reads, the drops it rates, grants, writes, `SET`, the two foreign-key pragmas, transaction control, maintenance). Every other statement is unsafe and named "comb does not recognize …; approve it in the file": triggers, functions, procedures, rules, `DO` blocks and other pragmas among them. comb's own FTS sync triggers stay recognized. Run `comb migrate check` on every pending file before upgrading, and approve each one a person has reviewed with `-- comb:allow-unsafe: <reason>`; applied files are never re-rated.
- Policies (`CREATE`, `ALTER`, `DROP POLICY`) and row level security changes are recognized and cautious, naming whose rows change on which table, so `--yes` applies them.
- A trigger the history left makes a write it fires on unsafe; a `TEMP` table that shadows a real one, a `CAST` in a rebuild's copy that is not text into text, and a call of a routine the history made inside an `ALTER TABLE` are unsafe.
- The proof run retries a file the copy refuses once on a reseeded copy, seeds distinct values and mixed-case parents, and meets common `CHECK` shapes; the live guard's reason comes first.
- `__drizzle_migrations` gains a `name` column, added on the first apply; a file applied under one hash and edited since is refused by `apply`, `check` and `status`. `recordMigrationHash` takes an optional name.
- A Postgres `check` of a database with tables and no history fails with apply's baseline message, without the dry run.
- A migrate config exported as a plain object is validated as `defineConfig` validates it; an invalid one that used to load is refused, naming the file.
- Turso `check` and `status` create no database and read with a one-hour read-only token. `_cf_` tables are reserved on D1 alone.
- A migrate database whose tables live under another name in `comb.config.ts` says so with `codegen: "<name>"`; `diff` takes the migrate name, as `apply` and `check` do.
- `ExtractedSchema` triggers gain `events` and `ftsSync`, and `TriggerEvent` is exported.
- `Connection.executeEach` is gone: the live guard reads every foreign key in one query, one wrangler call on D1.

**Query layer**

- **Cursors are sealed and scoped.** A cursor is encrypted (XChaCha20-Poly1305 under a key HKDF-SHA256 derives from the secret), so a client reads none of its values, and it is bound to a required `cursorScope` beside `cursorSecret`: the list's route and tenant, such as `` `members:${orgId}` ``. `createCursor`, `readCursor`, `queryHelpers.listOptions`, `queryHelpers.paginate`, `buildListQuery` and `buildDerivedListQuery` take it; an empty one is a 500 `cursor_not_wired`. Every 0.10 cursor is `invalid_cursor` after the upgrade, once, so a client on page 2 starts over.
- The list schema takes any cursor string, and `readCursor` refuses every one it cannot use, malformed, over-long or minted under another order included, with `invalid_cursor`. `cursorProblem` takes the cursor alone; `verifiedCursor` is `openCursor`. The published `CURSOR_EXAMPLES` changed.
- A cursor fits what the driver returned: a bigint on a number column (libsql's bigint mode, bun:sqlite's `safeIntegers`), epoch milliseconds on a key declared as time. ±Infinity and NaN page as themselves.
- A sort value too long for a cursor goes by reference, the keyset reading it from the row. A `buildDerivedListQuery` list passes `keyset: "derived"` to `paginate`, and gets a 500 on the page that meets such a value. `CursorValue` includes `CursorRef`.
- A Postgres `timestamp` that may hold `'infinity'` is read in string mode: drizzle's date mode reads it as 2000-01-01.
- `filter` is capped at 4608 bytes, `q` at 600, `order` at 200 and `select` at 500, however a URL or a form encodes them (`REQUEST_BYTES`), beside their character caps.
- A page no schema validated is refused past 10 000 with the new key `page_too_deep`.
- `buildFilterSQL`'s `columnMap` takes `{ column, unit: "s" }` for a date stored in seconds.
- **`_search` columns change format**: Greek final ς folds to σ, the marks that make й, ї and ё letters of their own stay, and the text is NFC-composed, so Hangul syllables stay whole. Refold every `_search` column with `searchText(...)` after the upgrade.
- `likeSearch` drops a term with no letter or digit, as FTS does.

**Errors**

- New key: `PAGE_TOO_DEEP`. A `Record<CombErrorKey, string>` of translations needs it.
- `classifySqliteError`, `classifyD1Error` and `classifyPgError` return what each handler would throw, without throwing.
- A foreign-key violation of a row others still reference names the statement's table, the parent, on every engine, wherever the SQL is recorded; a bare node-postgres error names none. SQLite reads a constraint or table name with any character in it.

**Codegen**

- **Relation names come from each key alone.** A many is the plural source when its key is the target's plain `<target>_id`, else `<plural>By<Column>` (`postsByAuthor`, `citiesByCountryCode`, `foldersByParent`); a unique key's way back is a singular `r.one`. A table's only key to a target renames too when it is not the plain `<target>_id`: where `posts` reaches `users` by `author_id` alone, `users.posts` of 0.10 is `users.postsByAuthor`. Regenerate, and update every `with:` that names a renamed relation.
- Constraint values are read on the AST: an inline string means what the same text in a const means (`"/^\d+$/"` is `/^d+$/`), a spread or a computed value fails codegen, and a pattern is `/source/flags` that compiles, with `u` or `v` at most (write a case-insensitive rule into the source, as `[A-Za-z]`).
- DTOs: a `nomutate` column is in the create DTO; a text column named `*Id` takes the id rules only when it is `c.id` or references one; `c.timestamp` takes epochs before 1970; reads take any stored email or URL; a foreign key stays out of the update DTO and in `immutable`, unless it declares `{ mutable: true }`, the opt-in for a reference that moves (a person's team, a category's parent); a column named `createdAt` is autogenerated only when something fills it.
- Constraint maps: a `CHECK` named after its table carries the table once in its key, every `CHECK` but comb's `_enum` and `_size` conventions is "Check constraint violated" with a 400, enum columns' `CHECK`s are mapped, and Postgres keys are cut to 63 bytes. Update translations of a changed key.
- Codegen refuses an unexported table, two constraints sharing an error key, a config `dialect` its tables contradict, and two databases writing one path. A run of the whole config deletes the files of a database the config no longer declares; another tool's generated file is refused; your own `./dtos/*` exports stay.
- A Postgres database's diagram DDL is Postgres DDL.

## Upgrading to 0.10

0.10 closes the findings of a fresh review of 0.9.1. It is a breaking minor; what changes for a project on 0.9:

**Migrations**

- **A proof runs before `check` and `apply`** on bun:sqlite, libsql and D1: each pending file runs on an in-memory copy of the live schema, seeded with rows, and a lost row, a lost column or a value changed, copied or moved makes it unsafe. The target is only read. The classifier stays authoritative; a passing proof never relaxes it.
- **More is unsafe**: a trigger is rated by its body, a call by its routine's body, a write to a rebuild's copy before the rename, an affinity-changing rebuild, `ON CONFLICT` and `STRICT` drift, `DO INSTEAD NOTHING`. A restrictive or `FORCE` row level security policy is cautious.
- **An empty target** (no table of its own) on the SQLite family applies a history with unsafe files, saying "empty target"; Postgres is unchanged.
- `check` and `status` read the database read-only on every engine; `check` skips Atlas's dry run when nothing is pending.
- comb no longer rewrites `CREATE INDEX` and `DROP INDEX` to `IF [NOT] EXISTS`: each file applies as written. A history that relied on it fails where an index already exists; run every history from empty before upgrading.
- SQLite table names compare case-insensitively, as SQLite does.
- `migrate init` scaffolds no `atlas.hcl`; delete one an earlier `init` wrote, as no comb command reads it.
- `ExtractedSchema` gains `externalFts`, and `TableInfo` gains `affinity`, `conflicts` and `strict` (all required).

**Query layer**

- **Cursors are signed.** `createCursor`, `readCursor`, `queryHelpers.listOptions`, `queryHelpers.paginate`, `buildListQuery` and `buildDerivedListQuery` take a required `cursorSecret` of at least 32 UTF-8 bytes: give every worker the same `CURSOR_SECRET` and pass it at the call. A cursor 0.9 minted is `invalid_cursor` after the upgrade, so a client on page 2 starts over. `decodeCursor` is removed; use `readCursor`. `encodeCursor` is no longer exported from `@lovrozagar/comb/query`.
- The cursor cap is 8192 characters (`MAX_CURSOR_LENGTH`), and `paginate` throws `sort_not_wired` rather than mint a longer one.
- A number past ±2^53−1 in a filter is a 400.
- `page` runs to `pagination.maxPage` (10 000 by default, published as `maxPage`); page further by cursor.
- An `extend` key the schema owns (`cursor`, `filter`, `filterAst`, `lang`, `limit`, `order`, `page`, `parsedFields`, `parsedSort`, `q`, `select`, `sortOrderBy`, `validated`) is a type error and a `TypeError` at construction.
- `createRetrieveQuerySchema` is strict, and takes `lang` only with `lang: true`.
- A derived sort key that yields epoch milliseconds is declared `{ sql, type: "date" }` in `sortColumns`.
- FTS searches every word and character of a term, `AND`, `OR` and `NOT` included; a term with no letter or digit is skipped.
- **`_search` columns**: write them with `searchText(...)` and backfill existing rows with it, since `likeSearch` folds each term the same way (NFKD, lowercase, Latin diacritics, the Latin letter folds). `likeSearch` takes an SQL expression too.
- `paginate(rows, query, { cursorSecret, idField })` pages rows keyed by another field.

**Errors**

- New keys: `CONSTRAINT_VIOLATION` (a trigger's `RAISE`, P0001 on Postgres), `CURSOR_NOT_WIRED`, `EXCLUSION_CONSTRAINT_VIOLATION`, `VALUE_TOO_LARGE`. A `Record<CombErrorKey, string>` of translations needs them.
- A value a column cannot hold is the same 400 on every engine: SQLite's STRICT mismatch and a value too big, which were 500s, are now `invalid_value` and `value_too_large`.
- `ConstraintMap` gains `exclusion` for Postgres `EXCLUDE` constraints; a unique index on an expression is keyed by its name on SQLite too.

**D1**

- `openD1Session(d1, bookmark)` is now `openD1Session(d1, { bookmark, constraint })`, and a session without a bookmark opens on the primary (`first-primary`). Pass `{ constraint: "first-unconstrained" }` where a read may lag.

**Codegen**

- Create DTOs take no timestamps, and a natural key named `id` is required on create.
- An integer takes one range on every DTO, its declared bounds clamped to the column's; a count that may not go negative declares `{ min: 0 }`.
- On Postgres, writes refuse U+0000 in text and JSON.
- A text reference keeps its declared bounds; `imageUri` and https rules publish as patterns; examples meet their bounds, and a field with a `pattern` has none.
- A database name becomes identifiers camel-cased (`my-db` gives `MY_DB_…` and `createMyDbDb`); one that makes none fails the run.
- The run record moves to `.comb.codegen.json` beside `comb.config.ts`; the first run reads the old `.<prefix>.codegen.json` once and removes it. Commit the new file.
- A failing database writes nothing for any database.
- Tables whose generated paths differ only in case fail the run; a database holding both Postgres and SQLite tables fails it.
- A many relation whose name a column or a one relation of its table already holds takes a `Relation` suffix: `posts` becomes `postsRelation`, so a query's `with: { posts }` becomes `with: { postsRelation }`. Drizzle's `unique()` and a named `.unique()` reach the constraint map and the published `uniqueIndexes`; diagram SQL quotes every identifier; the FTS map lists SQL column names.
- A CHECK written `check("name", sql.raw("…"))` reaches the constraint map; a `check()` codegen cannot read fails the run. Regenerate, then translate the new error keys.

## Upgrading to 0.9

0.9.1 is the first 0.9 release on npm: 0.9.0 was tagged but never published, since its release failed before either registry received it. 0.9 closes the findings of a fresh review of 0.8.0. It is a breaking minor; what changes for a project on 0.8:

**Migrations**

- **Writes rate by what they may destroy.** Every `DELETE` is unsafe, whatever its `WHERE` (no reading of a `WHERE` proves it spares a row). An `UPDATE`, an upsert's `DO UPDATE`, and a `MERGE` that updates are unsafe unless they only backfill: they write a table the same file created, or only columns the same file added that nothing has written since, which is cautious. `REPLACE`, `INSERT OR REPLACE` and `UPDATE OR REPLACE` are unsafe. A data migration that `--yes` approved in 0.8 now needs `-- comb:allow-unsafe:` with its reason.
- **A rebuild's copy is cautious only in Atlas's form**: each column from itself, bare, cast, or `IFNULL(column, <its new default>)`, over the whole table. A copy that filters, joins, substitutes a value or renames a source is unsafe, naming the clause or the column.
- **Rowids survive a rebuild**, the rebuilt table's included, beside up to 99 columns; at 100 columns without an `INTEGER PRIMARY KEY` the rows are kept under new rowids and the classification names the table. New diffs write the copy as `INSERT INTO new_t (rowid, …) SELECT rowid, …`.
- **The rebuild guard defers its own keys**, so a closure that is a reference cycle refills; and a rebuild in a SQLite file with `-- atlas:txmode none` is refused by `diff` and unsafe for `apply`, as it needs the file's transaction.
- **D1 `status` and `check` write nothing**: a database without `d1_migrations` reads as nothing applied. Only `apply` and `baseline` create the table.
- **The D1 provider takes no `databaseId`.** Remove it from `comb.migrate.config.ts`: wrangler finds the database by `databaseName` and the wrangler config's `database_id`. A config that still passes one fails to load, saying so.
- `migrate apply`, `check` and `status` take `--json`: one object, `{ database, applied, pending, refused }`, as the only stdout, the human lines on stderr.
- `confirmDrops` and its `ConfirmDrops` type are removed from `@lovrozagar/comb/migrate`; `dropsQuestion` stays.

**Queries**

- An empty `or()` matches no row and an empty `and()` every row, alone or nested; 0.8 dropped an empty group, widening the filter.
- A number filter with an integer outside ±(2^53 − 1), and a date outside ±8.64e15 ms, is a 400, as is a cursor that carries such a date.
- A `q` that holds only FTS syntax (`AND OR`, `*`) matches no row; an empty `q` is still no search.
- Spellfix search requires every term, each matched by itself or one of its corrections; 0.8 matched any term.
- A relation filter back to the main table (`item → link → item`) reads the outer row; its join tables are aliased in the `EXISTS`.
- A relation without `relationFields` selects no field; declare the fields a client may embed.
- `parseSelect` throws a 400 (`invalid_select`) on a select it cannot parse, instead of returning null, which `queryHelpers.project` read as every column.
- `queryHelpers.paginate` throws `sort_not_wired` (500) when a row lacks a sort key or the id, instead of minting a cursor that repeats or ends the list.
- `escapeLike` is exported from `@lovrozagar/comb/query`. `hasRelation`, `hasScalarsRequested`, `getRelationSelection`, `buildRelationColumns`, `getEntityColumns`, `buildColumns`, `getPrimarySortDirection` and the `PaginationOptions` and `PaginationQueryInput` types are removed: nothing used them.

**Errors**

- A new built-in key, `INVALID_VALUE` (`invalid_value`): `pgErrorHandler` maps SQLSTATE 22003, 22P02, 22007 and 22008, a value the column cannot hold, to a 400 naming the column, never the value. A `Record<CombErrorKey, string>` of translations needs the key.
- On D1, `SQLITE_BUSY` and `SQLITE_LOCKED` are 503 `database_unavailable` and `SQLITE_READONLY` 503 `database_readonly`, as on libsql and bun:sqlite.
- A foreign-key violation is read as "still referenced" only from the tail Postgres writes after the key values, so a key value that spells the phrase no longer misleads it.
- The shard router stops routing an org once revalidation finds it soft-deleted, without waiting for the hard TTL.

**Codegen**

- A run writes nothing until every generator succeeds, then replaces its files at once; and it deletes what it wrote last time and no longer writes (a removed table's files), recorded in `.<prefix>.codegen.json` beside the output, never a file without comb's header. Commit that file with the output.
- A column spread, table name or column name comb cannot read fails codegen at its file and line, and so does a constraint key comb does not handle; `name` and `imageUri` are now enforced on writes.
- Read DTOs take a stored password hash as a plain string; update DTOs refuse an empty required string; an email is trimmed and lowercased before it is validated; an id-like column keeps its declared `min`/`max`.
- Timestamps keep the names the table declares: a table mixing `created_at` and `updatedAt` gets no shared spread, and `softDelete` names the property. `TimestampsMeta` gains `names` and a `mixed` style.
- On Postgres, `c.integer` DTOs are bounded to int4, and the enum CHECKs import from `drizzle-orm/pg-core`; the dialect comes from the config, else from the tables file's comb columns import.
- The FTS reference SQL drops and rebuilds each index before creating it again; `_shared` emits only what the DTOs import (the unused timestamp validators and refinements are gone); a relations file without relations is `() => ({})`; two tables whose names make one type name, or that share an id prefix, fail codegen.

**Release**

- The package is published as bun packs it, so its manifest names resolved versions, never `catalog:`.

## Upgrading to 0.8.0

0.8.0 closes the findings of a fresh review of 0.7.0. It is a breaking minor; what changes for a project on 0.7:

**Migrations**

- **D1 history moves to wrangler.** `comb migrate apply` on D1 checks the pending files (order, classification, approval), then hands them to `wrangler d1 migrations apply`, so the history is wrangler's `d1_migrations`, ordered by numeric prefix, then name. A database wrangler already migrated needs nothing; one comb 0.7 migrated through `__drizzle_migrations` takes a one-time `comb migrate baseline <db>`, which copies that history. The D1 provider takes `wranglerConfig` and `wranglerEnv`, and `--file` is refused on D1. `wrangler` (`>=4.147.0`) and `drizzle-kit` (`>=1.0.0-rc.4`) are optional peers: install the one your provider uses.
- **Baseline compares before it records.** On libsql, bun-sqlite and Postgres, `baseline` records the history only when the live database matches what it leaves; on Postgres the compare covers tables (Atlas OSS inspects no view, policy or sequence).
- **Row level security is comb's.** The first 0.8 Postgres diff enables row level security on every table with policies, which Atlas OSS dropped without a word, so rows disappear for roles that do not bypass RLS. Grant `BYPASSRLS` or write the policies those roles need before you apply it.
- **Rebuilds are guarded.** A SQLite table rebuild that cascades to other tables keeps their rows (comb copies and restores them) and rates the file unsafe. The first 0.8 diff of a history comb 0.7 wrote from a raw drizzle-kit rc.4 export rebuilds its text-primary-key tables once, since comb now adds the `NOT NULL` the export left out.
- **More is gated.** `PREPARE`/`EXECUTE`, `setval`, rule actions, `COPY FROM`, `REASSIGN OWNED` and writable pragmas are unsafe or cautious, `OWNER TO` is cautious, and `CREATE INDEX CONCURRENTLY` or `VACUUM` outside `-- atlas:txmode none` is refused.
- `migrate diff --dry-run` prints the migration without writing it, and `migrate check` runs the apply checks alone.
- A file `diff` writes always sorts after the history: one Atlas stamps in the same second as, or before, the latest file (two diffs in one second, a teammate's clock ahead) is renumbered a second past it.
- Removed: `applyMigration`, `verifySchema`, `createBackupTables`, `cleanupBackupTables`, `generateMigrationFile` and `GenerateMigrationOptions`. `applySqliteMigrationTransforms(sql, before?, fts?)` takes the schema the earlier files leave and the FTS state.

**Queries**

- `RelationConfig` is `{ sourceKey?, target, targetKey, through, throughSourceKey, throughTargetKey }`: `throughKey` is split into the junction's two keys, and every key is a column's property name. Relation filters work again.
- `buildFtsWhere({ table, ftsTable }, q)` and `buildFtsWhereWithSpellfix({ table, ftsTable, spellfixTable, … })` match by rowid; `idColumn` is gone.
- `DEFAULT_SORT` is no longer exported, and `sort: []` orders by the tiebreak alone. `sortToOrderBy` and the JSON helpers of `sqlite/sql` (`jsonCol`, `jsonColAs`, `jsonBool`, `jsonNullable`, `buildScalarJsonParts`) are removed.
- A cursor from another sort is refused, a date filter binds a `Date` on date columns, and a number on a text column is refused.

**Errors**

- A composite unique violation reports its columns together, under the codegen key `<table>_<a>_<b>_duplicate`. Deleting a row others still reference reports "The record is still referenced by other records", with no column.
- On Postgres, `53300`, `53400`, `57P01`, `57P05` and `25P03` map to unavailable, and `55P03` to retry.
- Error text that carries a `params:` line (0.4.x's flattened cause chain) is no longer classified: a bound value may hold a newline and write the engine's words itself. Pass the error object, whose cause chain comb reads safely. A `DELETE` behind a `WITH` clause or a comment is read as the delete it is.

**Codegen**

- Each database gets only the tables its tables file declares (and the files it re-exports), and its imports resolve from wherever its output lands.
- When one package.json exports two databases, every subpath is namespaced by database: `./core/dtos/post`, `./audit/entities`. A package with one database keeps its subpaths.
- Columns and DTO files take the database's file prefix (`db.<name>.…`); direct mode (`--tables`) writes no package exports.
- A one-relation is named from its SQL column (`author_id` or `authorId` gives `author`), with `Relation` appended when a column already holds the name.
- Create and update DTOs leave out what comb or the database fills: `autogenerate` columns (the timestamps by default) and generated keys (`c.id`, `c.serialId`, `autoIncrement`, defaulted keys). A client can no longer choose an id or backdate a row.
- An integer foreign key gets an integer schema; a read DTO accepts a negative integer; `maxBytes` counts UTF-8 bytes. FTS DDL and generated keys quote what is not a plain identifier.
- The Postgres `c` takes the SQLite parameters: `text(name, constraints?)`, `integer(name, constraints?)`, `json(name, schema, constraints?)` and constraints on every timestamp; `pg.json<T>(name)` becomes `pg.json(name, schema)`. Constraints accept `private`.
- A hand edit to a generated file is put back on the next run, whatever its header says.

## Upgrading to 0.7.0

0.7.0 migrates Postgres: `comb migrate init --dialect postgres`, `diff`, `apply`, `baseline` and the new `status` work on a `postgres` provider through Atlas ([Postgres](#postgres)). SQLite, libsql, Turso and D1 work as before. What changes for code that uses the API:

- `ProviderConfig` is `ConnectionProviderConfig | PostgresProviderConfig`, and `createProvider()` takes a `ConnectionProviderConfig`: narrow on `type !== "postgres"` before you call it. `ResolvedDatabaseConfig.provider` carries the Postgres provider with its defaults filled in (`ResolvedPostgresProviderConfig`, `DEFAULT_PG_DEV_URL`).
- `generateSchemaDiff()` and `generateIncrementalMigration()` take a `target` (`devUrl`, `schema`, `lockTimeout`) on Postgres and refuse to run without one; the hard-coded `postgres://localhost:5432/dev` is gone.
- `exportDrizzleSchema()` takes `configPath` and, on Postgres, `schema`: it drops that schema's `CREATE SCHEMA` and refuses an object in another one.
- `migrate diff` reads `comb.migrate.config.ts` for the database's directory and drizzle config; it wrote to `./atlas-migrations` whatever the config said.

A database you migrated with `drizzle-kit migrate` under 0.6.0 moves over in three steps: point `migrationsDir` at a new, empty directory; run `comb migrate diff <db> baseline`, which writes the whole current schema as one migration; then `comb migrate baseline <db>` records it as applied without running it. From there, `diff` and `apply` take over; drizzle-kit's own history table is no longer read.

## Upgrading to 0.6.1

0.6.1 fixes the destructive-change gate of `comb migrate apply`, which let most drops through: a quoted or schema-qualified name (Atlas quotes every name it emits), a drop after another action in one `ALTER TABLE`, and a column Atlas drops on SQLite by rebuilding the table all classified safe. Every statement and every `ALTER TABLE` action is read now ([Diff and apply](#diff-and-apply)), so files that ran without a prompt may now stop:

- **`--yes` approves cautious files only.** An unsafe file needs a yes on a terminal, or a line `-- comb:allow-unsafe: <reason>` in the file. In CI, add the line to each unsafe migration you mean to run; comments do not change a migration's hash, so files already applied stay applied.
- **More is unsafe:** column retypes, renames, `CASCADE`, schema, type, sequence and role drops, and `DELETE` or `UPDATE` without a `WHERE`. `DROP NOT NULL` is safe now, and dropping a default or constraint is cautious.
- `classifyMigration()` and `extractDropStatements()` take `{ dialect, before }`: the dialect the file is read in (unnamed, both readings count and the stricter wins), and the schema the earlier files leave (`extractSchema(sql, from)` continues one). `MigrationClassification` adds `cautiousStatements` and `lockWarnings`. `segments()` and `splitSqlStatements()` take a dialect; a quoted identifier is now an `identifier` segment, and a Postgres `DO` body a `body` one.

## Upgrading to 0.6.0

0.6.0 closes the 0.5 review's findings. Four changes break callers:

- **State machines.** `assertTransition(machine, from, to)` takes three arguments. Name the column on the machine (`defineStateMachine({ column: "status", … })`) instead of passing it fourth.
- **Trusted list input.** `buildListQuery()` and `queryHelpers.listOptions()` refuse a `filterAst` or `parsedSort` without `validated: true` (`filter_not_wired` / `sort_not_wired`, 500). `createListQuerySchema()`'s output carries the flag, and it survives a framework that hands handlers the schema's output, as honey's `c.input.search` does. Code that builds a parsed query by hand, after checking the filter against its own fields, sets `validated: true` itself.
- **Postgres migrations.** The `postgres` and `neon` migrate providers are refused at load, and `createPostgresProvider`, `createNeonProvider`, `introspectPostgresSchema`, `getPostgresTables`, `getPostgresColumns`, `getPostgresIndexes`, `PostgresProviderConfig` and `NeonProviderConfig` are removed: they only ever threw. Run Postgres migrations with `drizzle-kit migrate`. The Postgres runtime modules are unchanged.
- **Keyset SQL.** `keysetSQL({ id, keys, tiebreak, values })` takes one `KeysetPosition` object instead of four arguments.

Fixes that change what a caller sees:

- **Error classification.** SQLite, D1 and Postgres errors are read from the innermost error out, so a wrapper whose message or bound params look like a constraint, storage-limit or SQLSTATE error no longer decides the class. A failed query is no longer reported as a constraint violation because a parameter says so.
- **Query layer.** A `select` nested deeper than eight levels is a 400 with the new key `invalid_select`, and parsing is linear in its length. A `Record<CombErrorKey, string>`, such as a message table, needs an `invalid_select` entry. A `(` in an unquoted filter value is a malformed filter, as a `)` already was; quote the value to match one.
- **D1.** `BookmarkTracker.track()` takes the `session` `openD1Session()` returns, `undefined` included, and tracks nothing for `undefined`. `ShardRouter` takes any KV with the three calls it makes (`ShardKv`), so a Worker's global `KVNamespace` fits.
- **Codegen.** Config mode names a database as the config does (`core`, not `db` for `src/db/core.tables.ts`), which renames its generated maps and diagrams. Generated subpaths are never written into a `package.json` above the project root. Temporary files of atomic writes are named with `randomUUID`.
- **Meta.** The manifest no longer lists unique indexes over private columns, matching the stamp.

New: `createUlidFactory()` for ULIDs that strictly increase, even through a clock that steps back. `KeysetPosition` is exported from `@lovrozagar/comb/query/sqlite`. The package's declared types are checked under `isolatedDeclarations` and every strict flag a consumer may set. That covers comb's own shipped types: the generated files (DTOs, relations, enum checks) and your drizzle tables module are your app's code, which `isolatedDeclarations` would flag for their inferred types, so keep them out of a project that sets it.

## Upgrading to 0.5.0

0.5.0 fixes defects whose fixes change behavior or API, so it breaks callers. Every break:

**Package**

- `zod` is a required peer; `@cloudflare/workers-types` is an optional peer; every peer range stops before its next major.
- `@lovrozagar/comb/cli` exports `runCli` and runs nothing on import; the executable is a bin shim, and the export moves to `src/cli/index.ts` (`HELP` is now `help()`).
- `./package.json` is exported.

**Errors**

- `handleConstraintViolation` takes the error, not its message; `extractTableColumn` is removed.
- SQLite and D1 errors are classified by engine code, not message text; Postgres by SQLSTATE on every driver. A Postgres 23000 is no longer a primary key violation: the primary key is a 23505 on `<table>_pkey`.
- `CombError.cause` is safe to show a client; the original error, with its SQL and parameters, is on the non-serialized `source`. D1 causes no longer include the SQL.
- New error keys: `filter_not_wired`, `sort_not_wired` (500, a handler wiring mistake) and `shards_full` (503).

**Codegen**

- Constraint maps, FK maps and FTS SQL are keyed by SQL column name, so regenerated files change for any column whose property name differs.
- Every generator takes `(ctx, config)`: `generateDtos(ctx, config)` with `ctx = { analysis, cwd, log, tablesPath, warn }`, and the same for the others.
- The `node-postgres`, `postgres-js` and `better-sqlite3` ORM drivers are not accepted; no client was ever generated for them.
- `output.default` in comb.config.ts is honored, so files move there if a config set it.
- Type comb.config.ts with `defineCodegenConfig` from `./codegen`.

**Query layer**

- Filter values are typed as declared: booleans bind as booleans (`published.eq.false` used to return the published rows), numbers and epoch-millisecond dates as numbers. A value that does not fit its type is a 400, and so is `is` with anything but null or notnull (or true or false on a boolean).
- A condition or sort the handler cannot run throws `filter_not_wired` or `sort_not_wired` instead of being dropped.
- `filterToSQL` takes `{ computedFilters, mainTable, relations }` and a validated AST; `coerceFilterValue`, `createFilterRefinement`, `defineListQuery`, `listQueryBaseSchema`, and `ListQuerySchemaConfig` are removed. `contains` is still parsed, for a caller that validates and runs it, but no declared field type takes it: `validateFilter` rejects it and `filterToSQL` answers it with `filter_not_wired`.
- `pagination.count` is `number | null`; `countExtra(query)` takes the parsed query or the built `ListQueryResult` and selects no window count for a cursor request. Cursor ids keep their JSON type.
- Limits: `maxInValues` 50 (was 100), 60 bound values per filter, 8 search words, and length caps on `filter` (2048), `order` (200) and `cursor` (8192 since 0.10), so every accepted request fits D1's 100 bound parameters.
- `select` refuses a relation nested inside a relation and an embed with no name.
- The list helper object is `queryHelpers`, not `drizzle`; `listOptions` needs `parsedSort` and pages the relational API by cursor.
- FTS terms are prefix phrases (`"term"*`); `buildFtsWhereWithSpellfix(db, { ftsTable, idColumn, spellfixTable }, q)`; `buildFtsHighlight(table, column, { start, end })`; `sanitizeFtsTerm` no longer doubles quotes; identifiers are single quoted names.
- `resolveTranslation` returns one row under that row's language code.

**Migrations and CLI**

- Migration hashes use the new normalization; files recorded under the old hash still count as applied. `checkMigrationHash` takes a hash or a list.
- `classifyMigration` calls `DROP TABLE IF EXISTS` unsafe, and reads code only.
- `migrate apply` reads `comb.migrate.config.ts` (`-e` for the environment), refuses a destructive migration without `--yes` or a terminal confirmation, and records each migration in the batch that applies it. Unknown options are errors; `codegen db core` names a database `db`: write `codegen core`.
- `getTursoCredentials` and `createTursoDatabase` take an options object; `sleep`, `confirmDrops`, `dropsQuestion`, `printMigrationSummary`, `aggregateErrors`, `EMPTY_OBJ` and `EMPTY_ARR` are no longer exported.

**PostgreSQL columns**

- `createdAt`, `updatedAt`, `deletedAt` and `timestamp` are `bigint` epoch milliseconds (they overflowed `integer`); existing tables need a migration that alters their type.

**Sharding and cache**

- A soft-deleted org is revived on its own shard; a full fleet throws `shards_full`.
- `LruCache` throws `RangeError` for options that would leave it unbounded or never expiring.

## Releases

Push a `v*` tag matching `packages/core/package.json`. The release workflow re-runs the full check set, publishes to npm with provenance via GitHub OIDC and to GitHub Packages, then opens a GitHub release with generated notes.

```bash
git tag v0.1.0
git push origin v0.1.0
```

## License

MIT © Lovro Žagar
