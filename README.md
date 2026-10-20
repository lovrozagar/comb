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
- **Codegen from the table files.** A ts-morph analyzer reads your Drizzle tables plus Comb's constraint annotations and emits DTOs, Zod schemas, relations, FTS5 tables, column name maps, ER diagrams, and a typed ORM client.
- **Migrations with a safety rail.** Atlas produces the diff; Comb classifies it, makes it idempotent, hashes it, records it, rewrites SQLite's `foreign_keys` pragma dance into a `defer_foreign_keys` prelude, and guards a rebuild of a table other tables reference so its drop deletes none of their rows.
- **A list-query layer.** A PostgREST-style `filter`, `order`, `select` grammar parsed into an AST, validated against declared field types, and lowered to SQLite SQL with cursor pagination and FTS5 search.
- **D1 at scale.** The Sessions API for read-after-write consistency, bookmark tracking, and an org-to-shard router with a three-tier LRU → KV → core-D1 lookup.

Every layer is usable on its own. Nothing here requires an HTTP framework.

## Install

```bash
bun add @lovrozagar/comb drizzle-orm zod
```

```bash
npm install @lovrozagar/comb drizzle-orm zod
```

```bash
pnpm add @lovrozagar/comb drizzle-orm zod
```

Comb ships TypeScript source, not a build. Your bundler or runtime compiles it.

| Runtime or tool | Supported | How                                                                                                                                  |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Bun             | yes       | runs the source directly                                                                                                             |
| `tsx`           | yes       | runs the source on Node                                                                                                              |
| Vite            | yes       | bundles it; set `ssr.noExternal` for an SSR or Worker build                                                                          |
| Wrangler        | yes       | bundles it into the Worker                                                                                                           |
| plain Node      | no        | type stripping refuses TypeScript in dependencies (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`); run it through `tsx` or a bundler |

The consumer suite (`bun run test:consumers`) checks each supported row in CI: it installs the packed tarball, imports every subpath under Bun and `tsx`, builds with Vite and Wrangler, and compiles every subpath with `tsc` under strict flags in a `bundler` and a `nodenext` project.

Peer dependencies:

| Package                     | Range               | Required                                                        |
| --------------------------- | ------------------- | --------------------------------------------------------------- |
| `drizzle-orm`               | `>=1.0.0-rc.4 <2`   | yes — the relational API (`defineRelations`) is v1-only         |
| `zod`                       | `>=4.5.4 <5`        | yes — every schema module builds on it (`z.compile` is Zod 4.5) |
| `ts-morph`                  | `>=28.0.0 <29`      | only for codegen                                                |
| `@libsql/client`            | `>=0.17.4 <0.18`    | only for the libsql/Turso migration providers                   |
| `@cloudflare/workers-types` | `>=5.20260815.1 <6` | only for the D1 modules' types (`sqlite/d1/*`)                  |
| `drizzle-kit`               | `>=1.0.0-rc.4 <2`   | only for `comb migrate diff`, which runs `drizzle-kit export`   |
| `wrangler`                  | `>=4.147.0 <5`      | only to migrate a D1 database, which wrangler applies           |

Each range stops before the next breaking release, so an install never pairs comb with a major it was not tested against.

The migration toolkit also shells out to [Atlas](https://atlasgo.io), which no package ships: `comb migrate diff`, `check`, `apply` and `baseline` need it on `PATH`. When `drizzle-kit` or `wrangler` cannot start, comb names the package and says to run comb through a package script (so `node_modules/.bin` is on `PATH`) or install it.

## First schema

Define a table with Comb's column factories instead of Drizzle's raw ones.

```ts
/* src/db/core.tables.ts */
import { sqliteTable, index } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
import { patterns } from "@lovrozagar/comb/sqlite/patterns"
import * as z from "zod"

export const author = sqliteTable(
	"author",
	{
		id: c.id("aut"),
		email: c.text("email", { max: 254, email: true, lowercase: true, trim: true }),
		display_name: c.text("display_name", { min: 2, max: 64, trim: true }),
		locale: c.text("locale", { pattern: patterns.LOCALE }),
		settings: c.json("settings", z.object({ digest: z.boolean() })),
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

The second argument to each factory is a **constraint object**. At runtime most of it is inert — `c.text("title", { max: 200 })` just becomes `text("title", { length: 200 })`. Its real job is to be read back out of the source by the codegen analyzer, which turns `{ min: 2, max: 64, trim: true }` into a Zod schema, a CHECK constraint, and an OpenAPI description. Constraints live next to the column, once.

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

```
comb — database codegen + migration toolkit

COMMANDS:
  codegen [db...]           Run codegen for the databases in comb.config.ts (all, or those named)
  codegen --tables <path>   Direct mode: analyze one tables file and generate beside it
  migrate init              Create drizzle.config.ts, atlas.hcl and atlas-migrations/
  migrate diff <db> [name]  Diff the schema and write the next migration
  migrate check <db>        Check and approve the pending migrations, applying nothing
  migrate apply <db>        Apply pending migrations: approve drops, apply and record each at once
  migrate baseline <db>     Record the migrations a database already reflects as applied
  migrate status <db>       Show a Postgres or D1 database's applied and pending migrations

OPTIONS:
  -g, --generator <name>  Run one generator only [codegen]
  --tables <path>         Analyze this tables file directly, no comb.config.ts [codegen]
  -e, --env <name>        Environment from comb.migrate.config.ts [migrate apply, migrate baseline, migrate check, migrate status]
  --dir <path>            Migrations directory (default: the config's, else ./atlas-migrations) [migrate apply, migrate baseline, migrate check, migrate status]
  --dialect <name>        The project's dialect: sqlite (default) or postgres [migrate init]
  --dry-run               Write nothing: exit 1 printing the migration a diff would write, 0 in sync [migrate diff]
  --file <path>           Apply this one migration file [migrate apply]
  -y, --yes               Approve cautious changes without asking (not unsafe ones) [migrate apply, migrate check]
  --local                 Without a migrate config: the local D1 (wrangler --local) [migrate apply, migrate baseline, migrate check, migrate status]
  --help                  Show this help
```

The binary requires Bun — the shebang is `#!/usr/bin/env bun`, and `comb migrate diff` invokes `bun drizzle-kit export`.

External tools the migration commands shell out to, none of them install-time dependencies:

| Command                                              | Needs                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `migrate diff`                                       | [Atlas](https://atlasgo.io) on `PATH`, plus `drizzle-kit`                                                                          |
| `migrate check`, `migrate apply`, `migrate baseline` | Atlas on `PATH` and the configured provider's client; for D1, `wrangler` (authenticated against the account for a remote database) |

The D1 provider drives `wrangler d1 execute` and `wrangler d1 migrations apply` as child processes, against the remote database by default; set `local: true` in its provider config, or pass `--local` without a migrate config, to target the local dev database. `wranglerConfig` (relative to `comb.migrate.config.ts`; default: the wrangler config beside it) and `wranglerEnv` name the wrangler config that binds the database and its environment, and comb passes them as `--config` and `--env` to every wrangler command.

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

`init` scaffolds `drizzle.config.ts`, `atlas.hcl` and `atlas-migrations/`; `init --dialect postgres` adds a `comb.migrate.config.ts` whose URL comes from `DATABASE_URL`, and no file holds a credential. `check` runs the check every apply runs first and applies nothing; it reads the database's history, so it needs the database. `baseline` adopts a database that already has the schema: it records the migrations as applied without running any, but only once the database's schema is the one they leave (on D1, only the files comb 0.7's `__drizzle_migrations` records). `status` lists a Postgres or D1 database's applied and pending migrations. `diff --dry-run` writes nothing: it exits 0 when the schema is in sync, and 1 printing the migration a diff would write.

## Columns

### SQLite factories

`@lovrozagar/comb/sqlite/columns` exports `c`:

| Factory                              | Emits                                               | Notes                                                                |
| ------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------- |
| `c.id(prefix)`                       | `text("id").primaryKey()`                           | `prefix` is type-erased metadata; codegen uses it for `generateId()` |
| `c.serialId()`                       | `integer("id").primaryKey({ autoIncrement: true })` |                                                                      |
| `c.text(name, constraints?)`         | `text(name)`                                        | `max` becomes `{ length: max }`                                      |
| `c.integer(name, constraints?)`      | `integer(name, { mode: "number" })`                 |                                                                      |
| `c.real(name, constraints?)`         | `real(name)`                                        |                                                                      |
| `c.boolean(name)`                    | `integer(name, { mode: "boolean" })`                |                                                                      |
| `c.enum(name, values)`               | `text(name).$type<T[number]>()`                     | `values` is type-erased; codegen emits the CHECK                     |
| `c.json(name, schema, constraints?)` | `text(name, { mode: "json" }).$type<z.infer<S>>()`  |                                                                      |
| `c.ref(name)`                        | `text(name)`                                        | chain `.references(() => other.id)`                                  |
| `c.timestamp(name, constraints?)`    | `integer(name, { mode: "number" })`                 | epoch milliseconds                                                   |
| `c.createdAt(name)`                  | non-null, defaults to `unixepoch() * 1000`          | name must be `createdAt` or `created_at`                             |
| `c.updatedAt(name)`                  | non-null, with `$onUpdate`                          | name must be `updatedAt` or `updated_at`                             |
| `c.deletedAt(name)`                  | nullable timestamp                                  | name must be `deletedAt` or `deleted_at`                             |

Timestamps are integer milliseconds, not SQLite's `TEXT` dates — comparisons, cursors, and index ranges all stay numeric.

### PostgreSQL factories

`@lovrozagar/comb/pg/columns` exports the same `c` shape backed by `drizzle-orm/pg-core` (`text`, `integer`, `serial`, `boolean`, `jsonb`, `doublePrecision`). Timestamps (`createdAt`, `updatedAt`, `deletedAt`, `timestamp`) are `bigint` epoch milliseconds read as JS numbers: a 4-byte `integer` overflows on today's time. A table file written against Comb's `c` compiles under either dialect by swapping the import.

### Constraints

The constraint object is shared by both dialects. `@lovrozagar/comb/sqlite/constraints` types them:

| Key                              | Applies to          | Effect                                                                                          |
| -------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `min` / `max`                    | text, integer, real | length or numeric bounds                                                                        |
| `maxBytes`                       | json                | UTF-8 byte bound on the serialized value, on writes                                             |
| `pattern`                        | text                | regex, as a source-level string                                                                 |
| `email` / `url`                  | text                | format validators                                                                               |
| `trim`, `lowercase`, `uppercase` | text                | transforms applied in generated schemas                                                         |
| `password`                       | text                | marks the field for hashing-aware DTOs                                                          |
| `private`                        | any                 | omitted from generated read DTOs                                                                |
| `nomutate`                       | any                 | omitted from generated create/update DTOs                                                       |
| `autogenerate`                   | any                 | server-assigned, omitted from create/update DTOs; defaults to `true` on the timestamp factories |

`private` and `nomutate` are the two that change generated output the most: a `password` column marked `private` never appears in a row DTO, and a `created_at` marked `autogenerate` never appears in a create DTO. A key comb or the database fills (`c.id`, `c.serialId`, an `autoIncrement` or defaulted key) is left out of create and update too, while a natural key the caller supplies stays. An integer without `min` takes no negative value on create or update; a read DTO accepts whatever the column holds.

### Patterns

`@lovrozagar/comb/sqlite/patterns` ships regexes as source-level strings so the codegen parser can copy them verbatim into `.regex()` calls:

```ts
import { patterns } from "@lovrozagar/comb/sqlite/patterns"

patterns.COUNTRY_ALPHA2 // "/^[A-Z]{2}$/"
patterns.E164_PHONE // "/^\\+[1-9]\\d{7,14}$/"
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
	cause: original,
})
```

`status` is a `StatusKey`, not a number — `bad_request`, `conflict`, `forbidden`, `unprocessable_entity`, `internal_server_error`, `service_unavailable`. The numeric `.status` is derived from it, so an HTTP layer can read `.status` and a log layer can read `.statusKey`.

Built-in keys (`combErrorKeys`): `CHECK_CONSTRAINT_VIOLATION`, `CURSOR_PAGINATION_UNSUPPORTED`, `DATABASE_IO_ERROR`, `DATABASE_READONLY`, `DATABASE_UNAVAILABLE`, `FILTER_NOT_WIRED`, `FOREIGN_KEY_VIOLATION`, `INVALID_CURSOR`, `INVALID_SELECT`, `INVALID_STATE_TRANSITION`, `PRIMARY_KEY_VIOLATION`, `REQUIRED_FIELD_MISSING`, `SEARCH_NOT_WIRED`, `SHARDS_FULL`, `SORT_NOT_WIRED`, `STORAGE_LIMIT_REACHED`, `UNIQUE_CONSTRAINT_VIOLATION`.

`SHARDS_FULL` (503) means no shard has room for a new organization: provision another D1 database.

### Constraint maps

A constraint map turns a database's constraint _name_ into your domain's error:

```ts
import type { ConstraintMap } from "@lovrozagar/comb"

export const authorConstraints: ConstraintMap = {
	author: {
		unique: {
			idx_author_email: {
				cause: "email",
				errorKey: "email_already_registered",
				statusKey: "conflict",
			},
		},
		foreignKey: {
			author_org_id_fk: { cause: "org_id", errorKey: "org_not_found" },
		},
		check: {
			author_locale_check: { cause: "locale", errorKey: "locale_invalid", statusKey: "bad_request" },
		},
	},
}
```

`comb codegen -g constraints` writes this file from your table definitions, so the constraint names always match what the migration actually created.

### Handlers

Three handlers, one signature — `(error: unknown, constraintMaps: ConstraintMap[]) => void`. Each walks the error's `cause` chain past wrappers such as drizzle's `DrizzleQueryError`, reads the engine's own code, finds the matching map entry, and throws a `CombError`. If nothing matches, they return and let the original error propagate.

<!-- ts-context
declare const db: { insert(table: unknown): { values(row: unknown): Promise<unknown> } }
declare const author: unknown
declare const input: unknown
declare const authorConstraints: import("@lovrozagar/comb/types").ConstraintMap
-->

```ts
import { d1ErrorHandler } from "@lovrozagar/comb/sqlite/d1/error-handler"
import { pgErrorHandler } from "@lovrozagar/comb/pg/error-handler"
import { sqliteErrorHandler } from "@lovrozagar/comb/sqlite/constraint-handler"

try {
	await db.insert(author).values(input)
} catch (error) {
	d1ErrorHandler(error, [authorConstraints])
	throw error
}
```

- `sqliteErrorHandler` — libsql, Turso and `bun:sqlite`. Classifies by SQLite's extended result code: the primary key by `SQLITE_CONSTRAINT_PRIMARYKEY`, a CHECK by its constraint name (in the statement's table first), a composite unique by its first column, NOT NULL with its column. It also maps `SQLITE_FULL` (422) and `SQLITE_BUSY` / `SQLITE_LOCKED` / `SQLITE_READONLY` (503).
- `d1ErrorHandler` — Cloudflare D1. Constraint violations go through the same SQLite mapping. Other errors with an SQLite code are query errors (500); a D1 platform failure without one is transient (503) or a storage limit (422).
- `pgErrorHandler` — PostgreSQL on node-postgres, postgres.js and Bun.SQL. Classifies by SQLSTATE (read from `code`, or Bun.SQL's `errno`) and reads `table`/`table_name`, `constraint`/`constraint_name` and `column`/`column_name` alike. The primary key is a 23505 on `<table>_pkey`.
- `handleConstraintViolation` — the constraint half of `sqliteErrorHandler`. It also accepts an engine message given as text.

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

`defineCodegenConfig` types the file, so a mistyped generator, `output` key or driver fails to compile. `output.default` is the directory every generator writes to unless the config names its own output; without it, files go beside the tables file.

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

```
/* @generated by comb — do not edit. checksum: bb552c750aeb */
```

Writes are atomic (temp file plus rename) and skipped when the checksum is unchanged, so codegen is safe to run on every build and produces no spurious diffs.

### Analyzer

```ts
import { analyze, validateTables, parseFieldConstraints } from "@lovrozagar/comb/codegen"

const result = analyze("./src/db/core.tables.ts")
```

`analyze()` returns an `AnalysisResult` — `TableMeta` per table with `FieldMeta`, `FieldConstraintsMeta`, `ForeignKeyRef`, `UniqueIndexMeta`, `CheckConstraintMeta`, and `TimestampsMeta`. It is a ts-morph pass over the source, not a runtime import, so it sees the constraint literals you wrote rather than the erased runtime values.

`validateTables()` runs the checks the generators assume: id prefixes match `^[a-z][a-z0-9]{1,9}$`, enum columns declare values, foreign keys resolve, translation tables pair with a base table.

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
					provider: { type: "d1", databaseId: process.env.CF_D1_ID!, databaseName: "core" },
				},
			},
		},
	},
})
```

The config is Zod-validated, so a typo fails at load rather than at apply. Each `provider` is a discriminated union on `type`: `bun-sqlite` (`path`), `libsql` (`url`, `authToken?`), `turso` (`org`, `apiToken`, `group`), `d1` (`databaseId`, `databaseName`), `postgres` (`url`, with `devUrl`, `schema` and `lockTimeout` defaulting to `docker://postgres/17/dev`, `public` and `5s`). There is no `neon` type: a Neon or Supabase database is a `postgres` URL. `environments` overrides the provider per `-e` flag, and every environment of a database has its dialect. `migrationsDir` and `drizzleConfigPath` are read relative to the config file, by `diff` as by `apply`.

A Postgres database is a URL, with the dev database Atlas replays migrations on beside it:

```ts
/* comb.migrate.config.ts */
import { defineConfig } from "@lovrozagar/comb/migrate"

export default defineConfig({
	databases: {
		analytics: {
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

- `url` reaches comb's Atlas runs only through their environment, never the command line, and comb checks it first: an unescaped `#`, `/`, `?` or `@` in the password is refused by field name, and every line of Atlas output comb relays is scrubbed of passwords and secret query values. `PG*` variables in your shell (`PGSSLMODE`, `PGPASSWORD`) are ignored, so the config is the only connection. comb warns when a remote host has no `sslmode=verify-full` or `require`, and on a Neon `-pooler` host or Supabase's port 6543: a transaction pooler drops the session lock Atlas holds.
- `devUrl` is an empty database Atlas may wipe; it must not be `url`. The default, `docker://postgres/17/dev`, needs Docker; match its major version to your server.
- `schema` is the one schema comb migrates. Both URLs are scoped to it (`search_path`), and Atlas keeps its history in `atlas_schema_revisions`, outside it. An object the drizzle schema puts in another schema, a Supabase `auth.users` reference included, is an error. A schema other than `public` must exist on both databases, and your app's `search_path` must match.
- `lockTimeout` bounds how long a statement waits for a lock (`0` for no bound), so an `ALTER` behind a long reader fails instead of queueing every later query. comb sets no `statement_timeout`; add one to the URL's `options` if you want it.

`loadConfig()`, `resolveDatabaseConfig()`, and `createProvider()` turn that into a `ConnectionProvider`. Each provider exposes the same `Connection` interface, and the SQLite introspection reads it: `introspectSqliteSchema`, `getSqliteTables`, `getSqliteColumns`, `getSqliteIndexes`.

A `multiTenant` block fans a migration out across every tenant database returned by `tenantQuery` against `rootDatabase`, bounded by `concurrency` and guarded by the `circuitBreaker` thresholds (`failureThreshold`, `minSampleSize`).

### Diff and apply

```bash
bunx comb migrate init
bunx comb migrate diff core add_post_slug
bunx comb migrate apply core --dir ./atlas-migrations
```

`diff` runs `bun drizzle-kit export` to dump the desired schema, hands it to Atlas, and writes a timestamped SQL file.

FTS5 tables stay out of what Atlas sees, because its dev SQLite has no fts5 module. Atlas replays a copy of the history with the FTS statements stripped and diffs a target without them. comb then appends the FTS part itself: for each FTS table whose definition changed, or whose content table Atlas rewrote (SQLite drops a table's triggers with it), it drops the triggers and the virtual table, creates them from the config, and runs `INSERT INTO <fts>(<fts>) VALUES ('rebuild')`. A database the config declares must load: a broken `tables` file is an error, not a diff without FTS. Since Atlas only ever sees the copy, comb checks the real `atlas.sum` against the files first.

A migration's hash is its SQL with comments and layout normalized away, never the text inside a literal. Files recorded under the pre-0.5.0 hash, which stripped `--` even inside literals, still count as applied (`migrationHashes()`, `checkMigrationHash()`).

`apply <db>` takes its database from `comb.migrate.config.ts` when the project has one: `-e/--env` picks the environment, whose provider supplies the connection, and `migrationsDir` is read relative to the config file. Without a migrate config, `<db>` is a D1 binding in the working folder's wrangler config, remote by default and local with `--local`. A Postgres database goes through Atlas ([Postgres](#postgres)). On every SQLite database, apply first checks, and applies nothing unless every pending file passes:

1. The directory matches its `atlas.sum`.
2. A file is pending unless the history records it: its hash, current or pre-0.5.0, in `__drizzle_migrations`, or on D1 its name in the binding's `migrations_table` (`d1_migrations`). A pending file that sorts before an applied one is refused, since it would run after files written later.
3. Each pending file is classified against the schema the earlier files leave: `parseMigration()`, `classifyMigration()` and `extractDropStatements()` read each statement, and each action of an `ALTER TABLE`, through quoted and schema-qualified names, and rate the file:
   - **unsafe** loses data or breaks deployed code by name: dropping a table, column, schema, type, sequence or role, `CASCADE`, changing a column's type, `SET NOT NULL`, adding a `NOT NULL` column without a default, renames, `TRUNCATE`, and `DELETE` or `UPDATE` without a `WHERE`. An unsafe file runs only after a yes on a terminal, or when the file approves itself with a line of its own, `-- comb:allow-unsafe: <reason>`, which goes through review with the file. `--yes` does not cover it, so a pipeline that always passes `--yes` cannot drop data unreviewed.
   - **cautious** drops nothing a row holds: indexes, constraints, defaults, views, triggers, functions, a filtered write, a grant, a new owner (who bypasses row level security), a sequence reset by `setval`, rows loaded by `COPY`, a call of a function a migration created, an `EXECUTE` of a statement comb cannot read, and a SQLite pragma comb does not write itself (`PRAGMA writable_schema` is unsafe). A write is read wherever it runs: in a CTE, a subquery, a rule's action, a `DO` body, the literal SQL a `DO` body `EXECUTE`s, a statement the file `PREPARE`s and then `EXECUTE`s, and behind `EXPLAIN ANALYZE`; a `WHERE` that holds for every row counts as none. It runs with `--yes` or a yes on a terminal.
   - **safe** runs without asking.

   Without a terminal or an approval, `apply` stops before running the file. A SQLite table rebuild (Atlas copies the rows into `new_t`, drops `t` and renames `new_t`) is cautious when it copies every column the earlier files gave `t`, and unsafe when it leaves one out, which is how Atlas drops a SQLite column. A rebuild of a table other tables reference is unsafe unless it carries comb's guard exactly as `comb migrate diff` wrote it (see below); an edit inside the guard makes it unsafe again.

4. On SQLite, libsql and Turso, comb applies each file's statements (`CREATE INDEX` and `DROP INDEX` made `IF [NOT] EXISTS`) and the insert of its hash as one batch, which every provider runs all-or-nothing. A file is applied and recorded, or neither. A transient failure (rate limit, reset connection) retries the whole batch through `withRetry()`. `--file` applies one file on its own, which no sum or order covers.

On D1, wrangler applies. comb reads the binding from the wrangler config with wrangler's own reader, refuses when its `migrations_dir` is not comb's `migrationsDir` or its `migrations_pattern` takes anything but that directory's `.sql` files, orders the files as wrangler does (by leading number, then name, so 8- and 14-digit prefixes mix), checks exactly the files wrangler will apply, and runs `wrangler d1 migrations apply` with stdin closed. wrangler runs each file and its `d1_migrations` row as one batch locally and one query remotely, and takes no backup, so bookmark a production database (Time Travel) before an apply. comb then reads the table back and fails unless it holds exactly the files it checked; a declined prompt or a failed file leaves its row out. `--file` does not apply to D1. A database comb 0.7 migrated records its files in `__drizzle_migrations`; apply refuses it until `comb migrate baseline <db>` copies that record into `d1_migrations` once.

`baseline <db>` records the files as applied without running them, for a database whose schema was set up out of band, after Atlas compares the database's schema with the one the history leaves; any difference is printed and nothing is recorded. On SQLite comb reads the schema from the database itself and compares FTS5 tables by name, since Atlas's dev SQLite has no fts5 module. On D1 it copies only what `__drizzle_migrations` records.

The circuit breaker (`createCircuitBreaker()` and its checks) is a library API for your own runners, such as a multi-tenant fan-out; the CLI does not use it, because one atomic batch per file already leaves nothing half-applied.

### Postgres

`diff` exports the drizzle schema with the database's `drizzleConfigPath` and hands Atlas the rest, on the dev database, scoped to `schema`. Atlas OSS refuses views, materialized views, policies, sequences, roles and extensions, so comb keeps them out of what Atlas replays and diffs and writes their part of the migration itself, around Atlas's statements:

- first, new extensions (`CREATE EXTENSION IF NOT EXISTS`), roles and sequences, since a table may use them, and a changed sequence `ALTER SEQUENCE`d in place, never dropped (that would restart it);
- then the drops of every changed or removed view and policy, and of each one over a table Atlas alters, since Postgres refuses to retype a column a view or policy reads; a view over a dropped view goes first;
- after Atlas's statements, those views and policies created again from the schema, and removed sequences dropped.

Roles and extensions are never dropped: they outlive one schema. Before Atlas replays the history, comb creates on the dev database every sequence and extension the history or the target holds (`CREATE … IF NOT EXISTS`), so a default calling `nextval` and a column of an extension's type (`citext`, `vector`, PostGIS) load there. An extension enters the history through a migration of your own with `CREATE EXTENSION IF NOT EXISTS …`, and the dev server must be able to install it (the stock `docker://postgres` image has `citext`, not `vector`). On a persistent `devUrl`, these sequences and extensions stay after the run; Atlas wipes only the schema it diffs.

An enum value Atlas adds goes into a file of its own a version earlier, since Postgres refuses to use a value added in the same transaction (55P04). Atlas cannot drop an enum value; comb says how to write that migration by hand. `CREATE INDEX CONCURRENTLY` needs its own file starting with `-- atlas:txmode none` and a blank line: Atlas honors a directive only with that blank line, and otherwise runs the file in one transaction, where the index fails. Every file comb writes keeps Atlas's directives first that way.

`apply` works on a private copy of the migrations directory, checked against `atlas.sum`, so what Atlas runs is exactly what comb read. It asks Atlas for its status and stops at any error, and at a file older than the latest applied one, which Atlas would skip without a word; a file Atlas ran halfway outside a transaction resumes only if unchanged, since Atlas resumes it by statement count. A dry run comes next, so a database that has objects but no history is told to `baseline` before anyone is asked. Each pending file is then classified and approved as on SQLite (unsafe: a yes on a terminal or `-- comb:allow-unsafe: <reason>`; cautious: `--yes` too), with lock warnings for statements that block a table: a non-concurrent index on an existing table, a volatile default, a scanning constraint without `NOT VALID`, a retype. Atlas then applies each file in its own transaction and records it; a failed file is named with its statement, and the files before it stay applied. Atlas holds a lock while it applies, so two applies never run at once. `--file` and `--local` do not apply to Postgres.

`baseline <db>` records every file up to the directory's latest as applied without running any, and refuses a database that already records migrations, and one whose tables are not the ones the history leaves on the dev database (Atlas OSS inspects no view, policy or sequence, so those are not compared). `status <db>` lists applied and pending files and warns of an applied file edited since, which Atlas never runs again. Atlas prints every statement it runs, so keep secrets out of data migrations; take a snapshot (a PITR point, a Neon branch) before an unsafe apply, and prefer expand-and-contract to renames and drops in one deploy.

### SQLite transforms

Atlas wraps SQLite table rebuilds in `PRAGMA foreign_keys = off;` … `PRAGMA foreign_keys = on;`. That pragma is a no-op inside a transaction, which is exactly where D1 runs it — so the rebuild proceeds with FK enforcement still live and fails. `applySqliteMigrationTransforms()` rewrites the pair into a single `PRAGMA defer_foreign_keys = on;` prelude, which defers the checks to commit time. It is idempotent and leaves every `CREATE`, `ALTER`, and `INDEX` statement byte-identical.

The pragma defers checks, never `ON DELETE` actions. With foreign keys on (always on D1, and by default in `@libsql/client`), Atlas's `DROP TABLE t` first deletes every row of `t`: `CASCADE` and `SET NULL` change the tables that reference it, `RESTRICT` fails, and `NO ACTION` fails at commit, since the rows return under the renamed copy. So `comb migrate diff` guards each rebuild of a referenced table. Between Atlas's copy and its drop it saves every table with a foreign-key path to `t` (Atlas's `new_t` too when it references `t`) into a `_comb_keep_<table>` table, saves `t`'s `sqlite_sequence` value, and empties those tables, each after the tables that reference it. After the rename it refills them in the opposite order, with their rowids, restores the sequence, and drops the keep tables. The guard doubles the writes to those tables, which counts against D1's 30-second limit per query on a large table; a 1M-row closure takes under a second on local SQLite. The diff refuses, naming the object, when a table it would empty has a trigger other than an FTS one (the trigger would fire on both the emptying and the refill), when a table already uses the `_comb_keep_` prefix, or when the history does not show a reached table's columns. Before such a file applies, `check` and `apply` also read the database's own foreign keys and triggers, and refuse when a table no migration made references the rebuilt table (its rows would go with the drop) or a trigger no migration made sits on a table the guard empties.

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

```
field.op.value          single condition
a.eq.1,b.gt.2           AND at top level
or(a.eq.1,b.eq.2)       OR group
and(...)                nested AND group
status.in.(draft,sent)  list values
@computed.eq.1          computed field (resolved by your resolver)
```

Operators: `eq`, `ne`/`neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`, `ilike`, `is`. `parseFilter` also reads `contains` for a caller that validates and runs it itself (JSON-array membership, say); no declared field type takes it. `is` takes `null` and `notnull` (any case) on every field, and `true` and `false` on a `boolean` one.

A value that holds `,`, `(`, `)` or `.` is written in double quotes, PostgREST style: `title.eq."Hello, world"`, `title.in.("a,b",c)`; inside quotes `\"` and `\\` escape. Whitespace around a bare value is trimmed.

`like` is case-sensitive and `ilike` ignores ASCII case. In both, `*` is the wildcard and every other character is literal: `like` lowers to SQLite `GLOB` (with `?` and `[` made literal), `ilike` to `LIKE … ESCAPE` (with `%` and `_` escaped). SQLite folds only ASCII case, so `ilike` does not match `Ž` against `ž`; search a pre-normalized column with `q` for that. An empty `in.()` matches nothing and an empty `nin.()` matches everything — neither widens to the whole table.

`validateFilter()` parses and checks in one step, against declared field types, and rejects operators a type does not support — `string` allows `like`, `boolean` allows only `eq`, `ne`, and `is`, and so on — and values that are not of the field's type: a `number` takes a decimal number, a `date` epoch milliseconds, a `boolean` `true` or `false`. A valid result carries each value typed as its field declares. Unknown fields are rejected rather than silently dropped, so a typo returns a 400 instead of the whole table. Unbalanced parentheses, an unclosed `in.(` list and trailing input are syntax errors. Each expression is bounded by `FILTER_LIMITS` — 20 conditions, 3 nested groups, 50 `in`/`nin` values per list and 60 bound values in all — overridable per call with a third `limits` argument. The defaults keep every request the list schema accepts within D1's 100 bound parameters per statement: 60 filter values, 8 search words (`maxSearchTerms`, one `LIKE` each), 10 for a three-key cursor and 2 for limit and offset make 80, which leaves 20 for your `baseWhere`. Raise a limit only on a database without that cap, or with a `baseWhere` that binds less. `createListQuerySchema` also caps the `filter` string at 2048 characters before parsing it (`limits.maxFilterLength`), as it caps `q` at 200, `select` at 500, `order` at 200 and `cursor` at 4096. `in` and `nin` take a list: `id.in.5` is a 400, not a driver error.

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

`parseFilter()` is the parse-only half, returning a `FilterAST` (or `null`) without validating field names.

### Sorting

`parseOrder()` accepts `field.asc`, `field.desc`, and null placement (`field.desc.nullslast`), producing `SortField[]`. Computed sorts use the same `@` prefix and are resolved through a `ComputedSortResolver`.

Null placement follows PostgreSQL: nulls sort last ascending and first descending, and an explicit `.nullsfirst` / `.nullslast` always wins. Every SQL builder emits the placement explicitly, so SQLite's opposite default never leaks through. `createListQuerySchema` caps one `order` at 3 keys (`limits.maxSortKeys`).

### Sparse fieldsets

`parseSelect()` implements PostgREST `select`, including relation selection:

```
select=id,title,author(display_name)
```

`createListQuerySchema({ fields })` is what puts `select` on the wire and `selectable` on `x-comb`. A relation's selectable fields are its declared `relationFields`; a relation nested inside one is not selectable, and `select=author(posts(id))` is a 400. Without `fields`, the param is omitted. The query stays fat (sort / id / `_total` / merge keys); the response gets thin. `queryHelpers.paginate` and `queryHelpers.project` honor `parsedFields` as the last mutation of item shape. Do not apply `select=` in the HTTP framework.

`getEntityColumns()`, `buildColumns()`, `buildRelationColumns()`, `getRelationSelection()`, `hasRelation()`, `hasScalarsRequested()`, and `filterBySelect()` turn the parsed selection into what Drizzle's `columns` and `with` options expect. `filterBySelect` stays exported for odd call sites; `queryHelpers.project` is the one-row wrapper.

### Pagination and cursors

Two modes share one input shape. Offset pagination takes `page` and `limit`; cursor pagination takes `cursor` and `limit`. Responses carry `PaginationMeta`.

A cursor holds the value of **every** sort key, the tiebreak id, and the signature of the sort it was minted under (`sortSignature()`), as URL-safe base64 of UTF-8 JSON. `createCursor(row, parsedSort)` mints one; `queryHelpers.paginate` does it for you. The keyset predicate compares all keys lexicographically, each with its own direction and null placement, so a multi-key or nullable order pages without skipping or repeating rows. A cursor presented under a different order, or one that does not decode, is a 400: the schema reports it on `cursor`, and `readCursor()` throws `CombError` (`invalid_cursor`) for callers that skip the schema.

For drizzle's relational API, `queryHelpers.listOptions(query)` returns `limit`, `offset`, an `orderBy` callback (the sort, its null placement and the id tiebreak) and, on a cursor request, a `where: { RAW }` keyset predicate to AND with your own: `db.query.post.findMany({ limit, offset, orderBy, where })`. A cursor minted under another order is `invalid_cursor`.

`pagination.count` is the number of rows the filter matches across all pages, or `null` when the response cannot know it. Select `queryHelpers.countExtra(query)` beside your columns (the parsed query, or the `ListQueryResult` built from it) and pass the rows to `queryHelpers.paginate`: an offset page reports the total (`0` for an empty first page), and a page past the end, or any query without the extra, reports `null`. A cursor page reports `null` too, and `countExtra` selects nothing for it: a `count(*) over()` window would make the database read every remaining row on each page, which is the cost keyset pagination exists to avoid (and on D1, rows read are billed). The tiebreak id keeps its JSON type in the cursor, so a numeric id compares as a number even when it is an expression with no column affinity. Every value a cursor carries must be a string, number, boolean, `null` or date; anything else is `invalid_cursor`.

```ts
import { createCursor, decodeCursor, readCursor, sortSignature } from "@lovrozagar/comb/query"
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
	pagination: { defaultLimit: 20, maxLimit: 100 },
	limits: { maxConditions: 20, maxDepth: 3, maxInValues: 50, maxValues: 60, maxSearchTerms: 8, maxSortKeys: 3 },
})

const parsed = postQuery.parse(request.query)
```

The object is strict and each optional parameter exists only when the endpoint honors it: `filter` needs at least one filter field, `q` needs `search`, `select` needs `fields`, `lang` needs `lang: true`. Anything else is a 400 — a parameter the handler would ignore can no longer answer with the unfiltered list. Declaring `search` obliges the handler to pass a resolver: `buildListQuery()` throws `search_not_wired` on a `q` it has no resolver for.

The `filter`, `order` and `q` descriptions, examples and the `order` pattern are generated per endpoint from the same config (`filterParamMeta()`, `orderParamMeta()`, `searchParamMeta()`), so a spec lists the real fields, types, operators and limits even after a publisher strips `x-*`. The schema also carries the `x-comb` query facts — `filterFields` with operators, `sortable`, `nulls`, `searchable`, `selectable`, and the limits — see `packages/core/docs/meta-contract.md`.

`createRetrieveQuerySchema()` is the single-resource counterpart (`select`, `lang`). `paginationResponseSchema` is exported for the response envelope. A list request is validated by `createListQuerySchema()` alone, and `buildListQuery()` refuses a filter or sort that did not come through it (see [SQLite SQL generation](#sqlite-sql-generation)).

### SQLite SQL generation

<!-- ts-context
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
declare const db: import("drizzle-orm/libsql").LibSQLDatabase
declare const parsed: import("@lovrozagar/comb/query").ListQueryOutput
const post = sqliteTable("post", { created_at: integer("created_at"), deleted_at: integer("deleted_at"), id: text("id").primaryKey(), title: text("title") })
-->

```ts
import { applyListQuery, buildListQuery, likeSearch } from "@lovrozagar/comb/query/sqlite"
import { isNull, sql } from "drizzle-orm"

const result = buildListQuery({
	parsed, // postQuery.parse(request.query)
	table: post,
	baseWhere: isNull(post.deleted_at), // ANDed in — soft deletes, tenant scoping, access rules
	search: likeSearch(post.title),
	computedSorts: { popularity: (dir) => sql`view_count ${sql.raw(dir)}` },
})

const rows = await applyListQuery(db.select().from(post).$dynamic(), result)
```

`parseFilter()` keeps filter values as strings; `validateFilter()` and the list query schema type them, so declared `number` and `date` fields bind as numbers and `boolean` as booleans, and a computed resolver receives the declared type. `buildListQuery()` and `filterToSQL()` expect that validated AST. A condition they cannot run, a computed field without a resolver, a resolver that returns `null`, a relation field with no `relations` entry, throws `filter_not_wired` (500) rather than being dropped, which would answer with more rows than the filter asked for. A sort field the table has no column for, or a computed sort without a resolver, throws `sort_not_wired` (500) the same way.

`buildListQuery()` returns `{ where, orderBy, limit, offset, search, meta }` — it builds clauses, it does not execute. `applyListQuery()` is the convenience that chains them onto a Drizzle query; skip it if you need to interleave joins. `meta.type` tells you whether cursor or offset pagination won (cursor takes precedence), and `limit` is deliberately `parsed.limit + 1` in cursor mode so you can detect a next page.

`buildListQuery()` and `queryHelpers.listOptions()` take a filter and an order only from the list query schema's output, which carries `validated: true`. A hand-built `filterAst` or `parsedSort` without it is refused (`filter_not_wired` / `sort_not_wired`, 500): checked against nothing, it could name any column of the table, `password_hash` included. Code that validated a filter against its own fields, as `validateFilter()` does, sets `validated: true` itself. `buildDerivedListQuery()` needs no flag: its caller passes the filter as SQL and maps every sortable field to a column.

`buildDerivedListQuery()` handles queries over a subquery or CTE, where sort columns come from a `sortColumns` map rather than the table. Underneath, `filterToSQL()` and `conditionToSQL()` are exported for advanced use, along with `orderSQL()` / `orderByKeys()` / `keysetSQL()` — the one ordering and keyset implementation every builder shares — and `patternToSQL()` for `like` / `ilike`.

Search comes in two flavours. `likeSearch(column)` is the portable fallback — it targets a pre-normalized `_search` column, strips diacritics, lowercases, escapes LIKE specials, and ANDs each whitespace-separated term. `buildFtsMatch()`, `buildFtsWhere({ table, ftsTable }, q)`, and `buildFtsHighlight()` target the FTS5 tables the `fts` generator created, and `buildFtsWhereWithSpellfix(db, { table, ftsTable, spellfixTable }, q)` adds spellfix1 fuzzy matching where the extension is available (without it, the terms are searched as typed). Every term becomes a bound prefix phrase, `"term"*`, so `post` finds `postgres`; FTS5 syntax in user text (`*`, `:`, parentheses, `AND`/`OR`/`NOT`) is removed or quoted, never interpreted. `sanitizeFtsTerm()` is that per-term cleaning. The FTS table name is a single identifier, quoted with `quoteIdent`. The generated FTS tables are keyed by their content table's `rowid`, so `buildFtsWhere` emits `<table>.rowid IN (SELECT rowid FROM <fts> WHERE <fts> MATCH ?)`: the rowid is qualified by the drizzle table you pass, so a join cannot make it ambiguous and a text `id` column never stands in for it.

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

const { client, session } = openD1Session(env.DB, bookmarkFromCookie)
const db = drizzle(client, { relations })
```

Reads go to the nearest replica while a bookmark guarantees the client never sees state older than its own last write. Without a bookmark it opens `first-unconstrained`. If `withSession` is missing — miniflare, older runtimes — it returns the raw handle and `session: undefined`, so the same code path works locally.

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

Resolution is three tiers: a per-isolate LRU with stale-while-revalidate, then KV, then the core D1 `shard_map` table (exported as a ready-to-use Drizzle table). A new org lands on the shard with the most headroom under `maxOrgsPerShard`. A new org's insert does nothing when another isolate inserted first, and the row read back afterwards is the winner's, so two isolates racing on an org's first request agree on one mapping. A soft-deleted org (`deleted_at` set) is revived on the shard it had, where its data is, even when that shard is at the cap; `log` reports it as an allocation with `revived: true`. When no shard has room for a new org, allocation throws `CombError` `shards_full` (503). Revalidation of a stale LRU entry is handed to `ctx.waitUntil()`, so it never sits in the request's critical path, and concurrent requests that see the same stale entry share one revalidation.

`invalidate(orgId, kv)` clears this isolate's LRU entry and the KV entry after a manual remap. Other isolates keep serving their LRU copy until it goes stale (`lruTtlMs`, 5 min), then revalidate from KV or the core table; an entry is never served past `lruHardTtlMs` (15 min). So a remap converges everywhere within `lruTtlMs` plus one revalidation: keep both shards readable for that long.

Tunables: `lruMaxSize` (1000), `lruTtlMs` (5 min), `lruHardTtlMs` (15 min), `kvTtlSeconds` (60), `maxOrgsPerShard` (500). Pass `log(event, data)` for a structured hook: `shard-router.hit` (`{ orgId, tier: "lru" | "kv" | "d1" }`, plus `stale` on an LRU hit), `shard-router.miss` (`{ orgId }`), `shard-router.allocate` (`{ orgId, shardId }`, plus `revived: true` for a revived org) and `shard-router.revalidate.error` (`{ orgId, error }`).

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

`LruCache` is the cache behind the shard router, exported on its own: bounded size, a soft TTL that marks entries stale for stale-while-revalidate (`getWithMeta()` returns `{ value, stale }`), and a hard TTL that evicts. Its constructor throws `RangeError` for a `maxSize` that is not a positive integer, a TTL that is not positive, or a `hardTtlMs` shorter than `ttlMs`, any of which would leave it unbounded or never expiring.

## Package exports

| Specifier                                    | Contents                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@lovrozagar/comb`                           | `CombError`, `createUlidFactory`, `generateId`, `generateUlid`, `LruCache`, error keys and types   |
| `@lovrozagar/comb/types`                     | `StatusKey`, `ConstraintMap`, `DatabaseErrorHandler`, …                                            |
| `@lovrozagar/comb/cli`                       | `runCli(argv, io)`: run the CLI in process and get its exit code                                   |
| `@lovrozagar/comb/codegen`                   | `analyze`, `validateTables`, `parseFieldConstraints`, analysis types                               |
| `@lovrozagar/comb/codegen/generators`        | every `generate*` function                                                                         |
| `@lovrozagar/comb/meta`                      | `combMeta`, `readCombMeta`, `readCombEntityMeta`, `readCombQueryMeta`, `carryCombMeta`, meta types |
| `@lovrozagar/comb/migrate`                   | config, providers, apply, parse, Atlas helpers                                                     |
| `@lovrozagar/comb/query`                     | filter, order, select, cursors, Zod builders                                                       |
| `@lovrozagar/comb/query/sqlite`              | SQL generation, FTS5, JSON helpers                                                                 |
| `@lovrozagar/comb/sqlite/columns`            | `c` for SQLite                                                                                     |
| `@lovrozagar/comb/sqlite/constraints`        | constraint types                                                                                   |
| `@lovrozagar/comb/sqlite/patterns`           | shared regex patterns                                                                              |
| `@lovrozagar/comb/sqlite/constraint-handler` | `sqliteErrorHandler`, `handleConstraintViolation`                                                  |
| `@lovrozagar/comb/sqlite/d1/session`         | `openD1Session`                                                                                    |
| `@lovrozagar/comb/sqlite/d1/bookmark`        | `BookmarkTracker`                                                                                  |
| `@lovrozagar/comb/sqlite/d1/error-handler`   | `d1ErrorHandler`                                                                                   |
| `@lovrozagar/comb/sqlite/d1/sharding`        | `ShardRouter`, `shardMap`                                                                          |
| `@lovrozagar/comb/states`                    | `defineStateMachine`, `canTransition`, `assertTransition`, `nextStates`, `isState`, `isTerminal`   |
| `@lovrozagar/comb/pg/columns`                | `c` for PostgreSQL                                                                                 |
| `@lovrozagar/comb/pg/error-handler`          | `pgErrorHandler`                                                                                   |

## Repository layout

```
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

## Upgrading to 0.8.0

0.8.0 closes the findings of a fresh review of 0.7.0. It is a breaking minor; what changes for a project on 0.7:

**Migrations**

- **D1 history moves to wrangler.** `comb migrate apply` on D1 checks the pending files (order, classification, approval), then hands them to `wrangler d1 migrations apply`, so the history is wrangler's `d1_migrations`, ordered by numeric prefix, then name. A database wrangler already migrated needs nothing; one comb 0.7 migrated through `__drizzle_migrations` takes a one-time `comb migrate baseline <db>`, which copies that history. The D1 provider takes `wranglerConfig` and `wranglerEnv`, and `--file` is refused on D1. `wrangler` (`>=4.147.0`) and `drizzle-kit` (`>=1.0.0-rc.4`) are optional peers: install the one your provider uses.
- **Baseline compares before it records.** On libsql, bun-sqlite and Postgres, `baseline` records the history only when the live database matches what it leaves; on Postgres the compare covers tables (Atlas OSS inspects no view, policy or sequence).
- **Row level security is comb's.** The first 0.8 Postgres diff enables row level security on every table with policies, which Atlas OSS dropped without a word, so rows disappear for roles that do not bypass RLS. Grant `BYPASSRLS` or write the policies those roles need before you apply it.
- **Rebuilds are guarded.** A SQLite table rebuild that cascades to other tables keeps their rows (comb copies and restores them) and rates the file unsafe. The first 0.8 diff of a history comb 0.7 wrote from a raw drizzle-kit rc.4 export rebuilds its text-primary-key tables once, since comb now adds the `NOT NULL` the export left out.
- **More is gated.** `PREPARE`/`EXECUTE`, `setval`, rule actions, `COPY FROM`, `REASSIGN OWNED` and writable pragmas are unsafe or cautious, `OWNER TO` is cautious, and `CREATE INDEX CONCURRENTLY` or `VACUUM` outside `-- atlas:txmode none` is refused.
- `migrate diff --dry-run` prints the migration without writing it, and `migrate check` runs the apply checks alone.
- Removed: `applyMigration`, `verifySchema`, `createBackupTables`, `cleanupBackupTables`, `generateMigrationFile` and `GenerateMigrationOptions`. `applySqliteMigrationTransforms(sql, before?, fts?)` takes the schema the earlier files leave and the FTS state.

**Queries**

- `RelationConfig` is `{ sourceKey?, target, targetKey, through, throughSourceKey, throughTargetKey }`: `throughKey` is split into the junction's two keys, and every key is a column's property name. Relation filters work again.
- `buildFtsWhere({ table, ftsTable }, q)` and `buildFtsWhereWithSpellfix({ table, ftsTable, spellfixTable, … })` match by rowid; `idColumn` is gone.
- `DEFAULT_SORT` is no longer exported, and `sort: []` orders by the tiebreak alone. `sortToOrderBy` and the JSON helpers of `sqlite/sql` (`jsonCol`, `jsonColAs`, `jsonBool`, `jsonNullable`, `buildScalarJsonParts`) are removed.
- A cursor from another sort is refused, a date filter binds a `Date` on date columns, and a number on a text column is refused.

**Errors**

- A composite unique violation reports its columns together, under the codegen key `<table>_<a>_<b>_duplicate`. Deleting a row others still reference reports "The record is still referenced by other records", with no column.
- On Postgres, `53300`, `53400`, `57P01`, `57P05` and `25P03` map to unavailable, and `55P03` to retry.

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

New: `createUlidFactory()` for ULIDs that strictly increase, even through a clock that steps back. `KeysetPosition` is exported from `@lovrozagar/comb/query/sqlite`. The package's declared types are checked under `isolatedDeclarations` and every strict flag a consumer may set.

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
- Limits: `maxInValues` 50 (was 100), 60 bound values per filter, 8 search words, and length caps on `filter` (2048), `order` (200) and `cursor` (4096), so every accepted request fits D1's 100 bound parameters.
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
