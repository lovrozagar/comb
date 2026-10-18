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
- [Upgrading to 0.5.0](#upgrading-to-050)
- [Releases](#releases)
- [License](#license)

## What Comb is

Comb sits on top of [Drizzle ORM](https://orm.drizzle.team). Drizzle stays the query builder and the runtime; Comb adds the parts a multi-dialect, multi-tenant application needs and Drizzle deliberately leaves open:

- **One column vocabulary across dialects.** `c.timestamp()`, `c.json()`, `c.id()` mean the same thing whether the table compiles to SQLite or PostgreSQL, so a table file can move between the two.
- **Constraint violations as domain errors.** A unique-index failure from D1, libsql, or Postgres becomes a single `CombError` with an `errorKey`, an HTTP status, and the offending table and column.
- **Codegen from the table files.** A ts-morph analyzer reads your Drizzle tables plus Comb's constraint annotations and emits DTOs, Zod schemas, relations, FTS5 tables, column name maps, ER diagrams, and a typed ORM client.
- **Migrations with a safety rail.** Atlas produces the diff; Comb classifies it, makes it idempotent, hashes it, records it, and rewrites SQLite's `foreign_keys` pragma dance into a transaction-safe `defer_foreign_keys` prelude.
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

Comb ships TypeScript source, not a build. Your bundler or runtime compiles it. Bun, Vite, Wrangler, and `tsx` all handle this out of the box.

Peer dependencies:

| Package                     | Range               | Required                                                        |
| --------------------------- | ------------------- | --------------------------------------------------------------- |
| `drizzle-orm`               | `>=1.0.0-rc.4 <2`   | yes — the relational API (`defineRelations`) is v1-only         |
| `zod`                       | `>=4.5.4 <5`        | yes — every schema module builds on it (`z.compile` is Zod 4.5) |
| `ts-morph`                  | `>=28.0.0 <29`      | only for codegen                                                |
| `@libsql/client`            | `>=0.17.4 <0.18`    | only for the libsql/Turso migration providers                   |
| `@cloudflare/workers-types` | `>=5.20260815.1 <6` | only for the D1 modules' types (`sqlite/d1/*`)                  |

Each range stops before the next breaking release, so an install never pairs comb with a major it was not tested against.

The migration toolkit also shells out to [Atlas](https://atlasgo.io) and `drizzle-kit`; both are runtime requirements of `comb migrate diff`, not install-time dependencies.

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
  migrate apply <db>        Apply pending migrations: confirm drops, apply and record each at once
  migrate baseline <db>     Record every migration as applied without running it

OPTIONS:
  -g, --generator <name>  Run one generator only [codegen]
  --tables <path>         Analyze this tables file directly, no comb.config.ts [codegen]
  -e, --env <name>        Environment from comb.migrate.config.ts [migrate apply, migrate baseline]
  --dir <path>            Migrations directory (default: the config's, else ./atlas-migrations) [migrate apply, migrate baseline]
  --file <path>           Apply this one migration file [migrate apply]
  -y, --yes               Apply destructive changes without asking [migrate apply]
  --local                 Without a migrate config: the local D1 (wrangler --local) [migrate apply, migrate baseline]
  --help                  Show this help
```

The binary requires Bun — the shebang is `#!/usr/bin/env bun`, and `comb migrate diff` invokes `bun drizzle-kit export`.

External tools the migration commands shell out to, none of them install-time dependencies:

| Command                             | Needs                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `migrate diff`                      | [Atlas](https://atlasgo.io) on `PATH`, plus `drizzle-kit`                                                      |
| `migrate apply`, `migrate baseline` | the configured provider's client; for D1, `wrangler` (authenticated against the account for a remote database) |

The D1 provider drives `wrangler d1 execute` as a child process, against the remote database by default; set `local: true` in its provider config, or pass `--local` without a migrate config, to target the local dev database.

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

```
comb migrate — database migration toolkit

COMMANDS:
  init                              Generate drizzle.config.ts + atlas.hcl
  diff <db> [name]                  Generate incremental migration from schema diff
  apply <d1-name> [--dir <path>]    Apply pending migrations to a D1 database
  apply <d1-name> --file <path>     Apply a single migration file (still hash-tracked)
  baseline <d1-name> [--dir <path>] Record migrations as applied WITHOUT running their SQL

OPTIONS:
  --dir <path>                      Migrations directory (default: ./atlas-migrations)
  --file <path>                     Single migration file to apply
```

`init` scaffolds `drizzle.config.ts`, `atlas.hcl`, and `atlas-migrations/`. `baseline` is the escape hatch for adopting Comb on a database that already has the schema: it fills `__drizzle_migrations` with the hashes without executing anything.

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

| Key                              | Applies to          | Effect                                                         |
| -------------------------------- | ------------------- | -------------------------------------------------------------- |
| `min` / `max`                    | text, integer, real | length or numeric bounds                                       |
| `maxBytes`                       | text                | byte-length bound                                              |
| `pattern`                        | text                | regex, as a source-level string                                |
| `email` / `url`                  | text                | format validators                                              |
| `trim`, `lowercase`, `uppercase` | text                | transforms applied in generated schemas                        |
| `password`                       | text                | marks the field for hashing-aware DTOs                         |
| `private`                        | any                 | omitted from generated read DTOs                               |
| `nomutate`                       | any                 | omitted from generated create/update DTOs                      |
| `autogenerate`                   | any                 | server-assigned; defaults to `true` on the timestamp factories |

`private` and `nomutate` are the two that change generated output the most: a `password` column marked `private` never appears in a row DTO, and a `created_at` marked `autogenerate` never appears in a create DTO.

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

Built-in keys (`combErrorKeys`): `CHECK_CONSTRAINT_VIOLATION`, `CURSOR_PAGINATION_UNSUPPORTED`, `DATABASE_IO_ERROR`, `DATABASE_READONLY`, `DATABASE_UNAVAILABLE`, `FILTER_NOT_WIRED`, `FOREIGN_KEY_VIOLATION`, `INVALID_CURSOR`, `INVALID_STATE_TRANSITION`, `PRIMARY_KEY_VIOLATION`, `REQUIRED_FIELD_MISSING`, `SEARCH_NOT_WIRED`, `SHARDS_FULL`, `SORT_NOT_WIRED`, `STORAGE_LIMIT_REACHED`, `UNIQUE_CONSTRAINT_VIOLATION`.

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

The config is Zod-validated, so a typo fails at load rather than at apply. Each `provider` is a discriminated union on `type`: `bun-sqlite` (`path`), `libsql` (`url`, `authToken?`), `turso` (`org`, `apiToken`, `group`), `d1` (`databaseId`, `databaseName`), `postgres` and `neon` (`connectionString`). `environments` overrides the provider per `-e` flag.

`loadConfig()`, `resolveDatabaseConfig()`, and `createProvider()` turn that into a `ConnectionProvider`. Each provider exposes the same `Connection` interface plus introspection (`introspectSqliteSchema`, `introspectPostgresSchema`, `getSqliteTables`, `getPostgresIndexes`, …).

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

`apply <db>` takes its database from `comb.migrate.config.ts` when the project has one: `-e/--env` picks the environment, whose provider (any of them, D1 included) supplies the connection, and `migrationsDir` is read relative to the config file. Without a migrate config, `<db>` is a D1 database name, remote by default and local with `--local`. Then, per migration file in name order (or the one `--file` names):

1. Ensures `__drizzle_migrations` exists.
2. Skips the file if its hash, current or pre-0.5.0, is already recorded.
3. Classifies it: `parseMigration()`, `classifyMigration()` and `extractDropStatements()` find what it drops or loses. A destructive file runs only with `--yes`, or after a yes on the terminal; with neither, `apply` stops before running it.
4. Applies its statements (`CREATE INDEX` and `DROP INDEX` made `IF [NOT] EXISTS`) and the insert of its hash as one batch, which every provider runs all-or-nothing (D1 as one `wrangler d1 execute --file`). A file is applied and recorded, or neither. A transient failure (rate limit, reset connection) retries the whole batch through `withRetry()`.

`baseline <db>` records every file as applied without running it, for a database whose schema was set up out of band.

Backup tables (`createBackupTables()`), schema verification (`verifySchema()`, `applyMigration()`) and the circuit breaker (`createCircuitBreaker()` and its checks) are library APIs for your own runners, such as a multi-tenant fan-out; the CLI does not use them, because one atomic batch per file already leaves nothing half-applied.

### SQLite transforms

Atlas wraps SQLite table rebuilds in `PRAGMA foreign_keys = off;` … `PRAGMA foreign_keys = on;`. That pragma is a no-op inside a transaction, which is exactly where D1 runs it — so the rebuild proceeds with FK enforcement still live and fails. `applySqliteMigrationTransforms()` rewrites the pair into a single `PRAGMA defer_foreign_keys = on;` prelude, which defers enforcement to commit time and is transaction-safe. It is idempotent and leaves every `CREATE`, `ALTER`, and `INDEX` statement byte-identical.

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

`createRetrieveQuerySchema()` is the single-resource counterpart (`select`, `lang`). `paginationResponseSchema` is exported for the response envelope. A list request is validated by `createListQuerySchema()` alone: `buildListQuery()` trusts the fields and values it is given, so an unvalidated filter or sort would let a client probe any column.

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

`buildDerivedListQuery()` handles queries over a subquery or CTE, where sort columns come from a `sortColumns` map rather than the table. Underneath, `filterToSQL()`, `conditionToSQL()`, and `sortToOrderBy()` are exported for advanced use, along with `orderSQL()` / `orderByKeys()` / `keysetSQL()` — the one ordering and keyset implementation every builder shares — `patternToSQL()` for `like` / `ilike`, and the JSON helpers `jsonCol()`, `jsonColAs()`, `jsonBool()`, `jsonNullable()`, and `buildScalarJsonParts()` for assembling a JSON row in SQL.

Search comes in two flavours. `likeSearch(column)` is the portable fallback — it targets a pre-normalized `_search` column, strips diacritics, lowercases, escapes LIKE specials, and ANDs each whitespace-separated term. `buildFtsMatch()`, `buildFtsWhere()`, and `buildFtsHighlight()` target the FTS5 tables the `fts` generator created, and `buildFtsWhereWithSpellfix(db, { ftsTable, idColumn, spellfixTable }, q)` adds spellfix1 fuzzy matching where the extension is available (without it, the terms are searched as typed). Every term becomes a bound prefix phrase, `"term"*`, so `post` finds `postgres`; FTS5 syntax in user text (`*`, `:`, parentheses, `AND`/`OR`/`NOT`) is removed or quoted, never interpreted. `sanitizeFtsTerm()` is that per-term cleaning. Table and id names are single identifiers, quoted with `quoteIdent`; the generated FTS tables are keyed by `rowid`, so pass `"rowid"` as the id column.

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
declare const session: D1DatabaseSession
declare function setCookie(name: string, value: string): void
-->

```ts
import { BookmarkTracker } from "@lovrozagar/comb/sqlite/d1/bookmark"

const tracker = new BookmarkTracker()
tracker.track(session, "core")
/* after the response body is settled */
for (const { tag, bookmark } of tracker.getBookmarks()) setCookie(tag, bookmark)
```

`getBookmarks()` skips sessions that never committed rather than throwing, so it is safe to call unconditionally at the end of a request.

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

| Specifier                                    | Contents                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@lovrozagar/comb`                           | `CombError`, `createUlidFactory`, `generateId`, `generateUlid`, `LruCache`, error keys and types |
| `@lovrozagar/comb/types`                     | `StatusKey`, `ConstraintMap`, `DatabaseErrorHandler`, …                                          |
| `@lovrozagar/comb/cli`                       | `runCli(argv, io)`: run the CLI in process and get its exit code                                 |
| `@lovrozagar/comb/codegen`                   | `analyze`, `validateTables`, `parseFieldConstraints`, analysis types                             |
| `@lovrozagar/comb/codegen/analyze`           | the analyzer alone                                                                               |
| `@lovrozagar/comb/codegen/generators`        | every `generate*` function                                                                       |
| `@lovrozagar/comb/migrate`                   | config, providers, apply, parse, Atlas helpers                                                   |
| `@lovrozagar/comb/migrate/drivers`           | provider factories and introspection                                                             |
| `@lovrozagar/comb/query`                     | filter, order, select, cursors, Zod builders                                                     |
| `@lovrozagar/comb/query/sqlite`              | SQL generation, FTS5, JSON helpers                                                               |
| `@lovrozagar/comb/sqlite/columns`            | `c` for SQLite                                                                                   |
| `@lovrozagar/comb/sqlite/constraints`        | constraint types                                                                                 |
| `@lovrozagar/comb/sqlite/patterns`           | shared regex patterns                                                                            |
| `@lovrozagar/comb/sqlite/constraint-handler` | `sqliteErrorHandler`, `handleConstraintViolation`                                                |
| `@lovrozagar/comb/sqlite/d1/session`         | `openD1Session`                                                                                  |
| `@lovrozagar/comb/sqlite/d1/bookmark`        | `BookmarkTracker`                                                                                |
| `@lovrozagar/comb/sqlite/d1/error-handler`   | `d1ErrorHandler`                                                                                 |
| `@lovrozagar/comb/sqlite/d1/sharding`        | `ShardRouter`, `shardMap`                                                                        |
| `@lovrozagar/comb/pg/columns`                | `c` for PostgreSQL                                                                               |
| `@lovrozagar/comb/pg/error-handler`          | `pgErrorHandler`                                                                                 |

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
