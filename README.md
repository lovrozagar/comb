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
bun add @lovrozagar/comb drizzle-orm zod @noble/ciphers @noble/hashes
```

```bash
npm install @lovrozagar/comb drizzle-orm zod @noble/ciphers @noble/hashes
```

```bash
pnpm add @lovrozagar/comb drizzle-orm zod @noble/ciphers @noble/hashes
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

| Package                     | Range               | Required                                                             |
| --------------------------- | ------------------- | -------------------------------------------------------------------- |
| `drizzle-orm`               | `>=1.0.0-rc.4 <2`   | yes — the relational API (`defineRelations`) is v1-only              |
| `zod`                       | `>=4.5.4 <5`        | yes — every schema module builds on it                               |
| `@noble/ciphers`            | `>=2.0.0 <3`        | yes — cursors are sealed with its XChaCha20-Poly1305                 |
| `@noble/hashes`             | `>=2.0.0 <3`        | yes — the cursor key is derived with its HKDF-SHA256                 |
| `ts-morph`                  | `>=28.0.0 <29`      | only for codegen (resolves imports, and loads TypeScript under node) |
| `@libsql/client`            | `>=0.17.4 <0.18`    | only for the libsql/Turso migration providers                        |
| `@cloudflare/workers-types` | `>=5.20260815.1 <6` | only for the D1 modules' types (`sqlite/d1/*`)                       |
| `drizzle-kit`               | `>=1.0.0-rc.4 <2`   | only for `comb migrate diff`, which runs `drizzle-kit export`        |
| `wrangler`                  | `>=4.147.0 <5`      | only to migrate a D1 database, which wrangler applies                |
| `libpg-query`               | `>=17.7.4 <18`      | only to migrate Postgres: comb reads each statement with it          |

Each range stops before the next breaking release, so an install never pairs comb with a major it was not tested against.

Comb's schemas are plain Zod; none is compiled. A Worker refuses the code a compiled schema builds (`new Function`), so there the compiler only added to the bundle. A Node or Bun app that wants compiled parsing opts in with `import "zod/compile"` as the first import of its entry: every schema built after it, comb's included, compiles on its first parse, and one the compiler cannot take keeps Zod's own parser. Zod 4.5.4 is the first release with that import.

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

```
comb — database codegen + migration toolkit

COMMANDS:
  codegen [db...]           Run codegen for the databases in comb.config.ts (all, or those named)
  codegen --tables <path>   Direct mode: analyze one tables file and generate beside it
  migrate init              Create drizzle.config.ts and atlas-migrations/
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
  --hashes                On D1: record the current hash of each applied file that has none (check the files against git first) [migrate baseline]
  --json                  Print one JSON object (database, applied, pending, refused) as the only stdout [migrate apply, migrate check, migrate status]
  --help                  Show this help
```

The binary requires Bun — the shebang is `#!/usr/bin/env bun`, and `comb migrate diff` invokes `bun drizzle-kit export`.

The CLI is tested on Linux and relies on POSIX process groups, so Windows is not supported: `comb codegen` loads each tables module in a child of its own process group, which a supervisor kills whole, with every process the module started, after 60 s or when the run is interrupted. The library itself (columns, queries, error handling) runs wherever its database driver does.

External tools the migration commands shell out to, none of them install-time dependencies:

| Command                                              | Needs                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `migrate diff`                                       | [Atlas](https://atlasgo.io) on `PATH`, plus `drizzle-kit`                                                                          |
| `migrate check`, `migrate apply`, `migrate baseline` | Atlas on `PATH` and the configured provider's client; for D1, `wrangler` (authenticated against the account for a remote database) |

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

`init` scaffolds `drizzle.config.ts` and `atlas-migrations/`, and no `atlas.hcl`: comb runs Atlas with a config of its own, and comb's unsafe gate, not an Atlas `skip` block, is what stops a drop. Delete an `atlas.hcl` an earlier `init` wrote; `init --dialect postgres` adds a `comb.migrate.config.ts` whose URL comes from `DATABASE_URL`, and no file holds a credential. `check` runs the check every apply runs first and applies nothing; it reads the database's history, so it needs the database. `baseline` adopts a database that already has the schema: it records the migrations as applied without running any, but only once the database's schema is the one they leave (on D1, only the files comb 0.7's `__drizzle_migrations` records). `status` lists a Postgres or D1 database's applied and pending migrations. `diff --dry-run` writes nothing: it exits 0 when the schema is in sync, and 1 printing the migration a diff would write.

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
| `email` / `url`                  | text                | format validators                                                                                                                                                                                                            |
| `trim`, `lowercase`, `uppercase` | text                | transforms applied in generated schemas                                                                                                                                                                                      |
| `password`                       | text                | marks the field for hashing-aware DTOs                                                                                                                                                                                       |
| `private`                        | any                 | omitted from generated read DTOs, from every published list and from every error; a column whose property name starts with `_` is private without it                                                                         |
| `nomutate`                       | any                 | set on create, then never: omitted from the generated update DTO                                                                                                                                                             |
| `mutable`                        | a foreign key       | moves after creation: in the generated update DTO, where every other reference is set once; refused elsewhere and with `nomutate`                                                                                            |
| `relation: "…"`                  | a foreign key       | names the key's relation and its way back, where the column's role would take a column's own name (`currency` toward `currency.code`, a `parent` self-reference); an identifier, refused on a column that references nothing |
| `autogenerate`                   | any                 | server-assigned, omitted from create/update DTOs; defaults to `true` on `c.createdAt`, `c.updatedAt` and `c.deletedAt`, and on a timestamp-named column a default or `$onUpdate` fills, never by its name alone              |

`private` and `nomutate` are the two that change generated output the most: a `password` column marked `private` never appears in a row DTO, and a `created_at` marked `autogenerate` never appears in a create DTO. A key comb or the database fills (`c.id`, `c.serialId`, an `autoIncrement` or defaulted key, SQLite's integer rowid key) is left out of create and update too, while a natural key the caller supplies stays required, whatever its name. The timestamp columns are never part of a create body, so a client backdates no row. A write takes an integer's declared `min` and `max`, clamped to what the column holds (int4 on Postgres, a JS number's exact range on SQLite); a count that may not go negative declares `{ min: 0 }`. A read never refuses a stored row, which an older rule, a migration or an import may have stored past a bound: it holds a value only to what the engine holds the column to (a Postgres varchar's length, int2 or int4's range, a JS number's exact range, an enum's values), and states each declared bound, a `c.id`'s length of 1 to 48 and a SQLite text length among them, as `x-comb-minLength`, `x-comb-maxLength`, `x-comb-minimum` or `x-comb-maximum` in its JSON Schema. A text reference keeps its own bounds; a `c.ref` takes the id's when its target is a `c.id` key or it names none, as a reference to another database's key, and its own text rules when it names a non-id column. A write refuses U+0000 and an unpaired surrogate in text and in JSON, on both dialects, as no engine stores them as sent; the rule is a refine, which the JSON Schema states as `x-comb-text` (and a JSON byte limit as `x-comb-maxBytes`), never as a pattern, so a field's own `pattern` stays its pattern and a `c.json` field a `$ref` to its schema. The `imageUri` and `url` (https) rules are regexes, so the JSON Schema publishes them as patterns, and each OpenAPI example satisfies its field's bounds; a field with a `pattern` gets none.

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

Built-in keys (`combErrorKeys`): `CHECK_CONSTRAINT_VIOLATION`, `CONSTRAINT_VIOLATION`, `CURSOR_NOT_WIRED`, `CURSOR_PAGINATION_UNSUPPORTED`, `DATABASE_IO_ERROR`, `DATABASE_READONLY`, `DATABASE_UNAVAILABLE`, `EXCLUSION_CONSTRAINT_VIOLATION`, `FILTER_NOT_WIRED`, `FOREIGN_KEY_VIOLATION`, `INVALID_CURSOR`, `INVALID_PAGE`, `INVALID_SELECT`, `INVALID_STATE_TRANSITION`, `INVALID_VALUE`, `PAGE_TOO_DEEP`, `PRIMARY_KEY_VIOLATION`, `REQUIRED_FIELD_MISSING`, `SEARCH_NOT_WIRED`, `SHARDS_FULL`, `SORT_NOT_WIRED`, `STORAGE_LIMIT_REACHED`, `UNIQUE_CONSTRAINT_VIOLATION`, `VALUE_TOO_LARGE`.

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

`comb codegen -g constraints` writes this file from your table definitions, so the constraint names always match what the migration actually created. A CHECK enters the map from ``check("name", sql`…`)`` or `check("name", sql.raw("…"))`; a `check()` codegen cannot read, such as one named by a variable or built from a variable, fails the run with its file and line rather than be left out. A unique index on an expression, such as `lower(email)`, is keyed by its index name under `unique` on every dialect. On Postgres, an `exclusion` record maps an `EXCLUDE` constraint by name; without an entry its violation is a 409 `exclusion_constraint_violation`. `referenced` lists a table's columns that another table's foreign key points at, which codegen fills: on SQLite, whose message names no side, an `UPDATE` or an upsert's `DO UPDATE SET` that assigns one answers the neutral "Referenced record does not exist or is still in use", as it may have failed on a row that references the old value. A hand-written map should add it; without it the table's own key is blamed as before. `private` lists a table's private columns by SQL name, which codegen fills too: an error names none of them, so its `column` is unset and its cause generic ("Required field missing", "Duplicate value detected", "Invalid value"), and each constraint on one answers its table's own key for its kind, `<table>_duplicate`, `<table>_reference_not_found`, `<table>_value_invalid` or `<table>_check_failed`, which names neither the column nor the constraint. A map without the list names every column as before.

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
- `classifySqliteError`, `classifyD1Error`, `classifyPgError` — the same answers without throwing: the `CombError` each handler would throw, or `undefined` when it would throw nothing, so code that expects one violation can ask instead of catching: `classifyD1Error(error, maps)?.errorKey === "project_member_taken"`.

A rule a trigger enforces is the same 400 `constraint_violation` on every engine, its cause the message the app raised: `RAISE(ABORT, 'qty must be positive')` on SQLite, libsql and D1 (`SQLITE_CONSTRAINT_TRIGGER`), and `RAISE EXCEPTION 'qty must be positive'` (P0001) on Postgres. Write that message for the client.

Each handler answers a value the request sent that the column cannot hold from one shared table, so the same bad value is the same 400 on every engine. The answer names the column where the engine does, never the value: Postgres names none for text that is no number or a string past `varchar(n)` (22P02, 22001), so there the cause is a bare "Invalid value". `invalid_value` covers a string past `varchar(n)`, a number out of range, text that is no number, a NUL byte, a date that does not parse (SQLSTATE 22001, 22003, 22021, 22P02, 22P05, 22007, 22008), and a STRICT table's column given another type (`SQLITE_CONSTRAINT_DATATYPE`, `SQLITE_MISMATCH`). `value_too_large` covers a value too large for an index row (54000) and a string or blob past the engine's limit (`SQLITE_TOOBIG`, 2 MB on D1). A foreign-key violation from a delete or a key update of a row others still reference names the statement's table, the parent, on every engine, wherever the SQL is recorded (drizzle's error, postgres.js's own); a bare node-postgres error records none, and names no table.

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

A run writes nothing until every database's generators succeed, then writes them all at once, so a failing database leaves the others' files and `package.json` as they were. It then deletes what each database's last run wrote and no database wrote this time, but only files carrying comb's own header (`@generated by comb`, or a JSON `_generated` value starting `comb `); another tool's generated file is refused like a file of your own. A table that was removed, a `filePrefix` that changed and an `output.default` that moved all count, and a run of the whole config (no database named, no `-g`) also deletes the files of a database the config no longer declares. Two databases that would write one path fail the run, naming both. In `package.json`, codegen owns `./tables`, `./relations` and the `./dtos/*` subpaths that point at its own generated files; your own `./dtos/*` entries stay. The record of what each database wrote is `.comb.codegen.json` beside `comb.config.ts` (beside the tables file in `--tables` mode); commit it with the output. A database's name becomes the stem of generated identifiers, camel-cased across any character an identifier cannot hold (`my-db` gives `createMyDbDb` and `MY_DB_DB_CONSTRAINT_MAP`); a name that still makes no identifier fails the run. Without a `dialect` in the config, the drizzle builder each table's file imports decides it (`pgTable` or `sqliteTable`, through any re-export), and a database holding both is refused, as is a config `dialect` its tables contradict.

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

A generated file's relative imports follow the tsconfig nearest the tables file: under `node16` or `nodenext` each names its extension, `.js` for a TypeScript file, or the `.ts` itself under `allowImportingTsExtensions` or `rewriteRelativeImportExtensions`; under `bundler` and the older resolutions, none, as before.

A plain drizzle column, built with no `c` helper, is typed by its data type. On Postgres its create and update DTOs take what Postgres takes for that type, so a value the database would refuse is a 400 from the DTO, not a 22P02 from the insert: a `uuid` is `z.guid()`; a `date` `z.iso.date()`; a `timestamp` a local date-time and a `timestamptz` one with its offset, so neither loses the instant; a `time` `z.iso.time()` and a `timetz` the same with its offset; an `interval` an ISO 8601 duration; a `numeric(p, s)` decimal digits within its precision and scale, and in number mode a number Postgres's rounding keeps within them; a string-mode `bigint` digits within int8; a `real` a number float4 holds and does not round to zero; an `inet` an address, its netmask optional; a `cidr` the same with no bit set past its prefix length, through `isCidr` from the package root; a `macaddr` or `macaddr8` any spelling Postgres takes; a `bit(n)` exactly n bits. A few spellings Postgres also takes are refused for the canonical one (a date's `tomorrow`, `24:00:00`, a numeric exponent, a non-ISO interval; the 0.14 changelog lists each). A read DTO keeps the plain type, as a read never refuses a stored row. A data type comb has no rule for (a `sparsevec`, a buffer, a date mode) fails codegen, naming the column and the types comb does type.

### Analyzer

```ts
import { analyze, validateTables } from "@lovrozagar/comb/codegen"

const result = analyze("./src/db/core.tables.ts")
const { errors, warnings } = validateTables(result)
```

`analyze()` returns an `AnalysisResult` — `TableMeta` per table with `FieldMeta`, `FieldConstraintsMeta`, `ForeignKeyRef`, `UniqueIndexMeta`, `CheckConstraintMeta`, and `TimestampsMeta`. It loads the tables module and reads every table it exports as drizzle built it (`getTableConfig`) and as the `c` helpers recorded it, so a bound, an enum list or an id prefix is the value the module computes, however its source spells it. The module runs in a child process on the runtime codegen runs on, with only `PATH`, `HOME` and `NODE_OPTIONS` in its environment, comb's own working directory (where the config is, or where you run it with `--tables`; `analyze()` takes `{ cwd }`), as the app and drizzle-kit run it, and 60 seconds to load, so a tables module must be import-safe, as drizzle-kit already needs it to be: no connection, no secret read, no work at import. Under node the child loads TypeScript itself, resolving imports as the nearest `tsconfig.json` does (`paths` included); bun does that natively. A module that fails to load, a column comb cannot type, a `c.json` schema no module exports, or a key into a table the tables file does not export fails codegen, naming the file, the table and the column.

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

The config is Zod-validated, so a typo fails at load rather than at apply, whether it is exported through `defineConfig`, as a plain object, or as a function, sync or async, that returns one: every object is strict, and a key comb does not know is refused by name. `diff`, `apply`, `check` and `status` all take a database by its name here; a database whose tables and FTS live under another name in `comb.config.ts`, as two shards of one schema do, says so with `codegen: "shard"`, and `diff shard-0` reads that database's FTS. Each `provider` is a discriminated union on `type`: `bun-sqlite` (`path`), `libsql` (`url`, `authToken?`), `turso` (`org`, `apiToken`, `group`), `d1` (`databaseName`, the wrangler config's `database_name` or binding; wrangler finds the database through its config), `postgres` (`url`, with `devUrl`, `schema` and `lockTimeout` defaulting to `docker://postgres/17/dev`, `public` and `5s`). There is no `neon` type: a Neon or Supabase database is a `postgres` URL. `environments` overrides the provider per `-e` flag, and every environment of a database has its dialect. `-e` on a database that declares no environments is refused. `migrationsDir` and `drizzleConfigPath` are read relative to the config file, by `diff` as by `apply`.

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
- `schema` is the one schema comb migrates. Both URLs are scoped to it (`search_path`; a URL that names its own `search_path` must name this schema), and Atlas keeps its history outside it: `public`'s in `atlas_schema_revisions`, any other schema's in its own `atlas_schema_revisions_<schema>`, so two schemas of one database, each migrated by its own config, never share a history. A schema name that is not plain lower case, or would pass Postgres's 63-byte limit, is named by its hash. An object the drizzle schema puts in another schema, a Supabase `auth.users` reference included, is an error. A schema other than `public` must exist on both databases, and your app's `search_path` must match.
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
   - **unsafe** loses data or breaks deployed code by name: dropping a table, column, schema, type, sequence or role, `CASCADE`, changing a column's type, `SET NOT NULL`, adding a `NOT NULL` column without a default, renames, `TRUNCATE`, `DELETE` or `UPDATE` without a `WHERE`, an FTS5 `'delete'` or `'delete-all'` command, and a statement comb does not recognize, triggers and routines made or dropped among them. An unsafe file runs only after a yes on a terminal, or when the file approves itself with a line of its own, `-- comb:allow-unsafe: <reason>`, which goes through review with the file. `--yes` does not cover it, so a pipeline that always passes `--yes` cannot drop data unreviewed.
   - **cautious** drops nothing a row holds: indexes, constraints, defaults, views, a grant, a new owner (who bypasses row level security), a sequence reset by `setval`, rows loaded by `COPY`, an `EXECUTE` of a statement comb cannot read, and a SQLite pragma comb does not write itself (`PRAGMA writable_schema` is unsafe). It runs with `--yes` or a yes on a terminal.

   What a statement writes is read from the engine, never from its spelling. On SQLite the proof run reads it (below). On Postgres comb reads every statement with Postgres's own parser (libpg-query 17) and walks every node, so a write in a CTE, a subquery, a rule's action or behind `EXPLAIN ANALYZE` counts, and so does `UPDATE users*`, `U&"users"` or `"users"SET`:
   - a `DELETE`, a `MERGE` that updates or deletes, and an `UPDATE` or upsert of rows that were there before the file are unsafe; an `UPDATE` or upsert that only fills a table the file created, or only columns it added (once), is cautious;
   - a write to a table whose trigger the history holds fires it, and is unsafe;
   - a `TEMP` table or view, or one in `pg_temp`, that takes an existing table's name shadows it for the rest of the file, and is unsafe;
   - a `DO` block, a `CREATE FUNCTION`, `PROCEDURE` or `TRIGGER`, a `CALL`, and a call of any function that is not a pure built-in (`lower`, `now`, `gen_random_uuid`, `jsonb_build_object` and the like) run code comb does not read, and are unsafe; `setval` is cautious, as is `nextval`, whose advance a rollback does not undo; `current_setting`, which copies a setting into what it writes, and `dblink` are unsafe;
   - a statement Postgres cannot parse is unsafe.
   - **safe** runs without asking.

   Without a terminal or an approval, `apply` stops before running the file. A SQLite table rebuild (Atlas copies the rows into `new_t`, drops `t` and renames `new_t`) is cautious when it copies every column the earlier files gave `t`, and unsafe when it leaves one out, which is how Atlas drops a SQLite column. A rebuild of a table other tables reference is unsafe unless it carries comb's guard exactly as `comb migrate diff` wrote it (see below); an edit inside the guard makes it unsafe again.

   On bun:sqlite, libsql and D1, `check` and `apply` also run a proof first. Each pending file runs on a private in-memory copy of the database's live schema, seeded with six rows per table chosen so a change shows, one statement at a time. Before each statement runs, SQLite itself (`EXPLAIN`) says what it writes to the tables that were there before the file. An update of a column they had, a delete of their rows (a `REPLACE` that meets one included), a trigger on them it can fire (its `WHEN` is not evaluated), an update, delete or replace of a virtual table's rows, and a temp table or view that takes one's name make the file unsafe, whatever rows the statement meets and however it is spelled. A backfill of only the columns the file added is cautious, and a write to a table the file created is safe. Then every table that was there before is compared, row for row, on the columns it had. A lost row, a lost column, or a value changed, copied between columns or moved between rows makes the file unsafe, and the reason names the table and column. The one allowance: a NULL that becomes the new default of a column the file made NOT NULL is cautious. A file the copy cannot run is unsafe, with the statement and why, and so is every pending file after it, which nothing then proves. A table comb cannot seed is listed as unproven, with why. On Postgres, writes are rated from their text. The target is only read.

4. On SQLite, libsql and Turso, comb applies each file's statements, as written, and the insert of its hash as one batch, which every provider runs all-or-nothing. A file is applied and recorded, or neither. A transient failure (rate limit, reset connection) retries the whole batch through `withRetry()`. `--file` applies one file on its own, which no sum or order covers.

On D1, wrangler applies. comb reads the binding from the wrangler config with wrangler's own reader, refuses when its `migrations_dir` is not comb's `migrationsDir` or its `migrations_pattern` takes anything but that directory's `.sql` files, orders the files as wrangler does (by leading number, then name, so 8- and 14-digit prefixes mix), checks exactly the files wrangler will apply, and runs `wrangler d1 migrations apply` with stdin closed. wrangler runs each file and its `d1_migrations` row as one batch locally and one query remotely, and takes no backup, so bookmark a production database (Time Travel) before an apply. comb then reads the table back and fails unless it holds exactly the files it checked; a declined prompt or a failed file leaves its row out. `--file` does not apply to D1. A database comb 0.7 migrated records its files in `__drizzle_migrations`; apply refuses it until `comb migrate baseline <db>` copies that record into `d1_migrations` once. wrangler's table records names only, so comb records each applied file's hash beside it and refuses a file applied, then edited. A file applied before comb recorded hashes has none, and `status` names it; once you have checked those files against git, `comb migrate baseline <db> --hashes` records the current hash of each applied file that has none, after the same checks apply runs (it refuses while a name in the history matches no file, or a recorded hash is not its file's). Run it once; `--hashes` is for D1 alone, as every other history records each hash as it applies.

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

`validateFilter()` parses and checks in one step, against declared field types, and rejects operators a type does not support — `string` allows `like`, `boolean` allows only `eq`, `ne`, and `is`, and so on — and values that are not of the field's type: a `number` takes a decimal number, a `date` epoch milliseconds, a `boolean` `true` or `false`. A valid result carries each value typed as its field declares. Unknown fields are rejected rather than silently dropped, so a typo returns a 400 instead of the whole table. Unbalanced parentheses, an unclosed `in.(` list and trailing input are syntax errors. Each expression is bounded by `FILTER_LIMITS` — 20 conditions, 3 nested groups, 50 `in`/`nin` values per list and 60 bound values in all — overridable per call with a third `limits` argument. The defaults keep every request the list schema accepts within D1's 100 bound parameters per statement: 60 filter values, 8 search words (`maxSearchTerms`, one `LIKE` each), 10 for a three-key cursor and 2 for limit and offset make 80, which leaves 20 for your `baseWhere`. Raise a limit only on a database without that cap, or with a `baseWhere` that binds less. `createListQuerySchema` also caps the `filter` string at 2048 characters before parsing it (`limits.maxFilterLength`), as it caps `q` at 200, `select` at 500 and `order` at 200. A URL limit counts bytes once percent-encoded (Cloudflare's is 16 KB), and one CJK character is nine of them, so `filter` is also capped at 4608 bytes, `q` at 600, `order` at 200 and `select` at 500 (`REQUEST_BYTES`), each measured as the widest common encoding writes it: a space (`%20` in a URL) and a mark such as `~` or `!` (`%7E`, `%21` in a form) count as 3. With the cursor's 8192, the largest accepted query string is at most 14 KB however a client encodes it, `maxQueryBytes`: 16 KB less 2 KB for the path and the handler's own params. A value holding a lone surrogate, which no URL can carry, is refused. With the cursor's 8192 (`MAX_CURSOR_LENGTH`), the largest accepted query string stays near 15 KB, leaving room for the path. The schema takes any cursor string and `readCursor` answers every one it cannot use, a longer one included, with `invalid_cursor`, so a client restarts on one key; `paginate` carries a sort value too long for the cap by reference (see [Pagination and cursors](#pagination-and-cursors)). `in` and `nin` take a list: `id.in.5` is a 400, not a driver error.

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

A runtime field map, such as one built from a user table's columns, can give a field a spec in place of its type: `{ type, operators?, format? }`. `operators` replaces the type's defaults (`OPERATORS_BY_TYPE`) and may add `contains` on any type, its value typed as one scalar of the type, for an array or multi-select column whose lowering is yours (comb's `filterToSQL` runs no `contains`). It may also add `gt`, `gte`, `lt` and `lte` on a `string`, which compare text, so stored values must share one form: an ISO instant written in two offsets, `2024-01-01T01:00+01:00` and `2024-01-01T00:00Z`, is one instant that sorts as two. `format: "iso"` on a `date` takes ISO 8601 text, a date (`2024-02-29`) or a date-time with `Z` or an offset (`2024-01-01T00:00+14:00`), naming a real day and time by the proleptic Gregorian calendar (so `0000-02-29` is a day), in place of epoch milliseconds, and hands it back as written for a text column; `filterToSQL` answers one wired to a date or number column with `filter_not_wired`. A spec that lists an operator its type cannot type (`like` on a `number`, `in` on a `boolean`) or puts `format` on no date throws a `TypeError` naming the field, the operator and the type. `parseFilterNumber(raw)` is the number rule on its own: `{ value }`, or `{ error }` for a spelling `Number()` takes and comb does not (`0x4d2`, `0b1`, `0o7`, `1e999`) or an integer past ±(2^53 − 1), which a double would bind as its neighbour.

```ts
import { validateFilter } from "@lovrozagar/comb/query"

const rows = validateFilter("tags.contains.red,due.gte.2024-02-29", {
	due: { format: "iso", type: "date" },
	tags: { operators: ["contains", "is"], type: "string" },
})
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

`filterBySelect()` cuts a row down to the parsed selection, for call sites outside `queryHelpers.paginate`; `queryHelpers.project` is the one-row wrapper.

### Pagination and cursors

Two modes share one input shape. Offset pagination takes `page` and `limit`; cursor pagination takes `cursor` and `limit`. Responses carry `PaginationMeta`.

A cursor holds the value of **every** sort key, the tiebreak id and the signature of the sort it was minted under (`sortSignature()`), as UTF-8 JSON sealed with XChaCha20-Poly1305: one URL-safe base64 string of a version byte, a random 24-byte nonce, the ciphertext and its tag. A client can read none of the values it carries, a column the endpoint never selects included, and it cannot write one: either would let it learn, request by request, the value of a column it can sort by but not select. `createCursor(row, parsedSort, { cursorScope, cursorSecret })` mints one as `queryHelpers.paginate` does, a long value carried by reference (below) so the cursor stays within the cap `readCursor` holds. The keyset predicate compares all keys lexicographically, each with its own direction and null placement, so a multi-key or nullable order pages without skipping or repeating rows.

Two values seal a cursor. The secret is the app's, at least `MIN_CURSOR_SECRET_BYTES` (32) bytes of UTF-8, and the key is derived from it with HKDF-SHA256. Give every worker the same `CURSOR_SECRET` through its env. The scope names the list: its route and tenant, such as `` `members:${orgId}` ``. It is bound to the seal, so a cursor minted in one list, or for one tenant, opens in no other; without it, a client could mint a cursor where it can write the sort column and replay it where it cannot read that column. Pass both where the handler runs: `queryHelpers.paginate(rows, query, { cursorScope, cursorSecret })` seals, and `queryHelpers.listOptions(query, { cursorScope, cursorSecret })`, `buildListQuery({ cursorScope, cursorSecret, … })` and `readCursor(cursor, parsedSort, { cursorScope, cursorSecret })` open. Both are required: a shorter secret or an empty scope is a 500 (`cursor_not_wired`) on the first page. A list whose rows key their tiebreak under another field, as `buildDerivedListQuery({ idColumn })` pages them, passes it to both ends: `createCursor(row, sort, { cursorScope, cursorSecret, idField: "_id", keyset: "derived" })` and `queryHelpers.paginate(rows, query, { cursorScope, cursorSecret, idField: "_id", keyset: "derived" })`; no row holds a derived list's keys to read a reference back, so there a value too long for a cursor is a 500 (`sort_not_wired`).

A cursor sealed under another secret or scope, a tampered one, one spelled another way for the same bytes, one minted under another order, and one that does not decode are all `invalid_cursor`, a 400, so rotating the secret ends the lists in flight with a 400. The list schema takes no secret, since schema modules load where no env exists (a gateway's route codegen): it takes the cursor as a string, and only the opening calls read it, so a malformed cursor is `invalid_cursor` as a tampered one is.

A sort value too long for the cap, such as a title a client wrote, goes by reference: the cursor carries the row's id, the longest prefix of the value that fits and the value's length, both in code points, and the keyset reads the value from the row while the row still has that prefix and length. That is exact while the row is there unchanged; an edit that keeps both the prefix and the length still moves the bound to the new value. Once the row is deleted, or edited otherwise, the list resumes from the prefix (followed by U+10FFFF when descending), as a plain cursor resumes where its value stood: it may serve again rows whose value shares that prefix and skips none, under SQLite's binary and NOCASE collations and Postgres's C and POSIX. Under any other Postgres collation neither bound is safe, so the next page of a list whose anchor row was deleted or edited answers `invalid_cursor` (400), and the client starts the list again: `listOptions` adds an `extras` flag that `paginate` reads, so pass its result to `findMany` whole. A reference binds at most what the plain value would in the keyset, so the cursor's share of the parameter budget below holds.

On D1, whose results travel as JSON, a REAL holding ±Infinity reads as null, so a cursor minted from such a row carries null. On a SQLite number key a null cursor value is read back from its row where the row holds ±Infinity, and stays null otherwise. Once that row is deleted the null may have stood for NULL, +Infinity or -Infinity, so the list resumes from the earliest of them in its order (NULL where NULLs come first, else -Infinity ascending and +Infinity descending), which repeats rows and skips none. Set `nonFinite: "exact"` beside `cursorSecret` only when your driver reads ±Infinity back as Infinity, as a local libsql file and bun:sqlite do: a null cursor is then a real NULL, and a deleted NULL anchor resumes right after it. D1, and any driver that returns ±Infinity as null, keep the default.

For drizzle's relational API, `queryHelpers.listOptions(query, { cursorScope, cursorSecret })` returns `limit`, `offset`, an `orderBy` callback (the sort, its null placement and the id tiebreak) and, on a cursor request, a `where: { RAW }` keyset predicate to AND with your own: `db.query.post.findMany({ limit, offset, orderBy, where })`.

`pagination.count` is the number of rows the filter matches across all pages, or `null` when the response cannot know it. Select `queryHelpers.countExtra(query)` beside your columns (the parsed query, or the `ListQueryResult` built from it) and pass the rows to `queryHelpers.paginate`: an offset page reports the total (`0` for an empty first page), and a page past the end, or any query without the extra, reports `null`. A cursor page reports `null` too, and `countExtra` selects nothing for it: a `count(*) over()` window would make the database read every remaining row on each page, which is the cost keyset pagination exists to avoid (and on D1, rows read are billed). The tiebreak id keeps its JSON type in the cursor, so a numeric id compares as a number even when it is an expression with no column affinity. Every value a cursor carries must be a string, number, bigint, boolean, `null` or date; anything else is `invalid_cursor`. A number holds ±Infinity and NaN too, as a Postgres `double precision` or a SQLite `REAL` may. A Postgres `timestamp` in date mode pages exactly even where it holds `'infinity'`: node-postgres reads `'infinity'` and `'-infinity'` both as 2000-01-01 local time, so a cursor's bound on such a key is read from its own row, exactly as the order compares it. Once that row is deleted, the cursor resumes from its Date, or from the list's own end when the Date is that 2000-01-01, which repeats rows and skips none: a deleted `'infinity'` anchor ascending (or `'-infinity'` descending) starts the list again from its beginning, as node-postgres reads both infinities as one value. A `timestamptz` or `date` in date mode reads `'infinity'` and `'-infinity'` as a Date no JS Date holds, and so does a SQLite timestamp holding ±Infinity on bun:sqlite and libsql (D1 reads it as null, above). A cursor carries that Date as itself, never as the null group, and its bound is read from its row: exact while the row holds its infinity, and once the row is deleted or made finite, the list resumes from the direction's own end, repeating rows and skipping none. A derived list has no row to read, so there it is a 500 (`sort_not_wired`) on the page that meets one.

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

`page` runs from 1 to `pagination.maxPage` (10 000 by default, published as `maxPage` on `x-comb` and as the param's `maximum`); past it a client pages by cursor, as an offset that deep makes the database skip every row before it. A page past `maxPage` throws `CombError` `page_too_deep` (400) from `parse`, `safeParse` and `~standard.validate` alike, as `readCursor` throws `invalid_cursor`, so it reaches your error handler with the key a list no schema bounded answers; `safeParse` does not return it as an issue. A page that is no whole number from 1 in decimal digits (`0`, `1.5`, `0x10`, `1e3`) throws `invalid_page` (400) the same way, as `buildListQuery` and `paginate` answer it. `limit` takes decimal digits too, and any other spelling stays a validation issue. A `maxPage` whose last offset, `(maxPage - 1) * maxLimit`, would pass 2^53 - 1 is refused when the schema is built. `extend` adds params of your own, validated and returned as they are; it may not take a name the schema owns (`cursor`, `filter`, `filterAst`, `lang`, `limit`, `order`, `page`, `parsedFields`, `parsedSort`, `q`, `select`, `sortOrderBy`, `validated`), which the type refuses and the builder throws a `TypeError` for, since an extension under one would replace a value the schema checked.

The `filter`, `order` and `q` descriptions, examples and the `order` pattern are generated per endpoint from the same config (`filterParamMeta()`, `orderParamMeta()`, `searchParamMeta()`), so a spec lists the real fields, types, operators and limits even after a publisher strips `x-*`. The schema also carries the `x-comb` query facts — `filterFields` with operators, `sortable`, `nulls`, `searchable`, `selectable`, and the limits, the byte caps `maxFilterBytes` and `maxSearchBytes` among them — see `packages/core/docs/meta-contract.md`.

`createRetrieveQuerySchema()` is the single-resource counterpart: `select`, and `lang` when its config says `lang: true`. It is strict too, so a `filter` sent to a single-resource endpoint is a 400 rather than a 200 that ignored it, and its `extend` may not take `lang`, `parsedFields` or `select`. `paginationResponseSchema` is exported for the response envelope. A list request is validated by `createListQuerySchema()` alone, and `buildListQuery()` refuses a filter or sort that did not come through it (see [SQLite SQL generation](#sqlite-sql-generation)).

### SQLite SQL generation

<!-- ts-context
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
declare const db: import("drizzle-orm/libsql").LibSQLDatabase
declare const parsed: import("@lovrozagar/comb/query").ListQueryOutput
declare const env: { CURSOR_SECRET: string }
const post = sqliteTable("post", { created_at: integer("created_at"), deleted_at: integer("deleted_at"), id: text("id").primaryKey(), title: text("title") })
-->

```ts
import { applyListQuery, buildListQuery, likeSearch } from "@lovrozagar/comb/query/sqlite"
import { isNull, sql } from "drizzle-orm"

const result = buildListQuery({
	cursorScope: "post:list", // the list: its route, and its tenant where it has one
	cursorSecret: env.CURSOR_SECRET, // opens a cursor's seal
	parsed, // postQuery.parse(request.query)
	table: post,
	baseWhere: isNull(post.deleted_at), // ANDed in — soft deletes, tenant scoping, access rules
	search: likeSearch(post.title),
	computedSorts: { popularity: (dir) => sql`view_count ${sql.raw(dir)}` },
})

const rows = await applyListQuery(db.select().from(post).$dynamic(), result)
```

`parseFilter()` keeps filter values as strings; `validateFilter()` and the list query schema type them, so declared `number` and `date` fields bind as numbers and `boolean` as booleans, and a computed resolver receives the declared type. `buildListQuery()` and `filterToSQL()` expect that validated AST. A condition they cannot run, a computed field without a resolver, a resolver that returns `null`, a relation field with no `relations` entry, throws `filter_not_wired` (500) rather than being dropped, which would answer with more rows than the filter asked for. A sort field the table has no column for, or a computed sort without a resolver, throws `sort_not_wired` (500) the same way.

A filter on a relation field (`tags.slug`, through a `relations` entry) asks about the related rows: `eq`, `in`, `like` and the other positives match a row that has a related row matching, and the negatives match a row that has none matching their positive, so `tags.slug.ne.red` is a post not tagged red, an untagged one included, and never a post `tags.slug.eq.red` matches. `nin` is no related row in the list, `is.null` no related row with a value (an untagged post among them), and `is.notnull` no related row without one.

`buildListQuery()` returns `{ where, orderBy, limit, offset, search, meta }` — it builds clauses, it does not execute. `applyListQuery()` is the convenience that chains them onto a Drizzle query; skip it if you need to interleave joins. `meta.type` tells you whether cursor or offset pagination won (cursor takes precedence), and `limit` is deliberately `parsed.limit + 1` in cursor mode so you can detect a next page.

`buildListQuery()` and `queryHelpers.listOptions()` take a filter and an order only from the list query schema's output, which carries `validated: true`. A hand-built `filterAst` or `parsedSort` without it is refused (`filter_not_wired` / `sort_not_wired`, 500): checked against nothing, it could name any column of the table, `password_hash` included. Code that validated a filter against its own fields, as `validateFilter()` does, sets `validated: true` itself. The flag covers the filter and the order, never the page: a page is always a whole number from 1, and past the default `maxPage` (10,000) it is `page_too_deep`, unless it carries the schema's own `pageBounded: true`, which it sets under whatever `maxPage` it was built with. `buildDerivedListQuery()` needs no flag: its caller passes the filter as SQL and maps every sortable field to a column.

`buildDerivedListQuery()` handles queries over a subquery or CTE, where sort columns come from a `sortColumns` map rather than the table. Pass `keyset: "derived"` to `paginate` for such a list: no row holds its keys, so a value too long for a cursor is a 500 (`sort_not_wired`) on the page that meets it, rather than a reference the builder cannot read. Underneath, `filterToSQL()` and `conditionToSQL()` are exported for advanced use, along with `orderSQL()` / `orderByKeys()` / `keysetSQL()` — the one ordering and keyset implementation every builder shares — and `patternToSQL()` for `like` / `ilike`.

Search comes in two flavours. `likeSearch(column)` is the portable fallback: it targets a `_search` column (or any SQL expression, such as `sql.raw('"_search"')` on a table drizzle does not declare), folds each whitespace-separated term with `searchText()`, escapes LIKE specials, and ANDs the terms. Write the column with the same function, `searchText(title, body, …)`, so the stored text and the query cannot drift apart: a column filled by SQL `lower()` misses every accented query. Its format, which a backfill must reproduce: the parts present joined by one space, NFKD-normalized (so ＦＩＬＥ and ﬁ fold), lowercased, Greek final sigma ς written σ (so an uppercase query ending in Σ finds the word), combining marks (U+0300–U+036F) removed except those that make a Cyrillic letter of its own, which NFC puts back into one letter (й, ї, ё, ў stay apart from и, і, е, у; a stress mark, as in доро́га, goes), Hebrew points and cantillation (U+0591–U+05C7), Arabic harakat and Quranic marks (U+0610–U+061A, U+064B–U+065F, U+0670, U+06D6–U+06ED) and the tatweel (U+0640) removed, so שָׁלוֹם is שלום and مـحـمّد is محمد, the Latin letters with no decomposition spelled in ASCII (ß ss, æ ae, œ oe, ø o, ł l, đ d, ð d, þ th, ı i, ĸ k, ŋ n, ŧ t, ħ h), then NFC-composed again, so й and Hangul syllables stay whole. Greek accents fold (ά is α). A change to this format means rewriting every `_search` column; 0.11 changed it, and "Upgrading to 0.11" says how to refold. `buildFtsMatch()`, `buildFtsWhere({ table, ftsTable }, q)`, and `buildFtsHighlight()` target the FTS5 tables the `fts` generator created, and `buildFtsWhereWithSpellfix(db, { table, ftsTable, spellfixTable }, q)` adds spellfix1 fuzzy matching where the extension is available (without it, the terms are searched as typed). Every term becomes a bound prefix phrase, `"term"*`, so `post` finds `postgres`; FTS5 syntax in user text (`*`, `:`, parentheses, `AND`/`OR`/`NOT`) is quoted, never interpreted: inside its quotes every word and character of a term is searched as text, so `not found` needs both words and `error:timeout` finds that text. `sanitizeFtsTerm()` is the per-term cleaning: it removes control characters and skips a term with no letter or digit, which no token matches and which would otherwise empty the search. The FTS table name is a single identifier, quoted with `quoteIdent`. The generated FTS tables are keyed by their content table's `rowid`, so `buildFtsWhere` emits `<table>.rowid IN (SELECT rowid FROM <fts> WHERE <fts> MATCH ?)`: the rowid is qualified by the drizzle table you pass, so a join cannot make it ambiguous and a text `id` column never stands in for it. FTS5's `unicode61` tokenizer folds less: not ß to ss, æ to ae, a ligature such as ﬁ, halfwidth kana or a Greek accent. So an FTS table over the raw text misses a query typed in one of those folds, and one over a `searchText` column misses a query typed as written, unless the source says so: `buildFtsWhere({ folded: true, ftsTable, table }, q)` (and `buildFtsWhereWithSpellfix`, and `buildFtsMatch(name, q, { folded: true })`) folds each term with `searchText` first, so FTS over `_search` applies the folds `likeSearch` applies, per token prefix. It still finds less in two ways. FTS matches a term at the start of a token, where `likeSearch` matches a substring anywhere: `asse` finds no `reassess`, and a term inside an unspaced CJK, Thai or Hangul run (`都庁` in `東京都庁`, `국어` in `한국어`) finds no row, as the run is one token. And FTS drops symbols, which `unicode61` does not index, so `c++` searches `c*` and finds every row with a word that starts with c.

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

To place orgs yourself, `place({ orgId, shardId }, deps, ctx)` writes the same way: the first writer wins, an org that has a row keeps its shard, and the mapping that stands is returned. `move({ orgId, shardId }, deps, ctx)` overwrites the mapping and invalidates it; moving the org's rows is yours. `unplace(orgId, deps)` soft-deletes the mapping and invalidates it, and a later `place` or allocation revives the org on its shard.

`invalidate(orgId, kv)` clears this isolate's LRU entry and the KV entry after a manual remap; `move` and `unplace` call it. Other isolates keep serving their LRU copy until it goes stale (`lruTtlMs`, 5 min), then revalidate from KV or the core table; an entry is never served past `lruHardTtlMs` (15 min). KV keeps a mapping's `updatedAt`, and a put older than what KV holds is skipped, so a read in flight across another isolate's `move` does not write the old shard back; KV has no compare-and-set, though, so a newer put can still land between that check and the write. KV is a cache: a KV call that fails is logged and read as a miss, or a skipped write, so a request falls through to the core table and a `move` whose core write committed does not throw for it. So a remap converges everywhere within `kvTtlSeconds` plus `lruTtlMs` plus one revalidation: keep both shards readable for that long, or resolve with `resolveVerified(orgId, { coreDb, kv, present }, ctx)`. It resolves as `resolve` does, then asks `present(mapping)` whether the org's rows are on that shard; when they are not, it reads the primary past every cache and returns that mapping, or `undefined` for an org since unplaced, without probing again.

Tunables: `lruMaxSize` (1000), `lruTtlMs` (5 min), `lruHardTtlMs` (15 min), `kvTtlSeconds` (60), `missTtlMs` (5 s), `maxOrgsPerShard` (500), `pick`. The constructor throws a `RangeError` unless `totalShards` and `maxOrgsPerShard` are positive integers and `kvTtlSeconds` is an integer of at least 60, KV's floor for an expiration TTL: under it every put fails, so KV would cache nothing. An org id is at most 64 UTF-16 code units, the length `shard_map.org_id` holds (`ORG_ID_MAX_LENGTH`): `place`, `move` and `allocate` (so `resolveOrAllocate`) throw a `RangeError` for a longer one, and `resolve` answers it as a miss. A route that takes the org id from its path validates it first. Pass `log(event, data)` for a structured hook: `shard-router.hit` (`{ orgId, tier: "lru" | "kv" | "d1" }`, plus `stale` on an LRU hit), `shard-router.miss` (`{ orgId }`, also for an id longer than `shard_map.org_id`'s 64 characters, answered before KV, whose keys stop at 512 bytes), `shard-router.allocate` (`{ orgId, shardId }`, plus `revived: true` for a revived org, from allocation and `place`, once per row written: a `place` or allocation of an org already placed, or the isolate that lost a race to place it, logs none), `shard-router.move` (`{ orgId, shardId }`), `shard-router.reresolve` (`{ orgId, from, to }`, `to` undefined for an org since unplaced), `shard-router.kv.error` (`{ orgId, op: "get" | "put" | "delete", error }`) and `shard-router.revalidate.error` (`{ orgId, error }`).

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

## Upgrading to 0.14

- **D1 files applied before comb recorded hashes:** `comb migrate status <db>` names them (`No hash recorded for …`), and comb cannot tell whether one was edited since. Check those files against git, then run `comb migrate baseline <db> --hashes` once on each D1 database: it records each one's current hash, so a later edit is refused as any other is. It records a file's current text as the text that ran, which is the one thing it cannot verify, so run it from the commit that applied those files, after `git log` shows no edit to them since. It refuses, recording nothing, while the history names a file the directory lacks.

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
- **The text guard is a refine, published as `x-comb-text`, never a pattern.** Go's and Rust's validators compile every comb document; a field's own `pattern` stays its `pattern`, with no `allOf`; a written `c.json` field is `anyOf: [$ref]` to its schema, its own description kept, with `x-comb-text` and `x-comb-maxBytes` beside it. A JSON field's rules leave its description. A reference under the id rule, and a written `c.id`, take the guard after `^\S{1,48}$`, so U+0000 and a lone surrogate are refused there too.

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
