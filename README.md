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
bun add @lovrozagar/comb drizzle-orm
```

```bash
npm install @lovrozagar/comb drizzle-orm
```

```bash
pnpm add @lovrozagar/comb drizzle-orm
```

Comb ships TypeScript source, not a build. Your bundler or runtime compiles it. Bun, Vite, Wrangler, and `tsx` all handle this out of the box.

Peer dependencies:

| Package          | Range          | Required                                                     |
| ---------------- | -------------- | ------------------------------------------------------------ |
| `drizzle-orm`    | `>=1.0.0-rc.1` | yes — the relational API (`defineRelations`) is v1-only      |
| `zod`            | `>=3.0.0`      | only for `c.json()` schemas and the query-layer Zod builders |
| `ts-morph`       | `>=25.0.0`     | only for codegen                                             |
| `@libsql/client` | `>=0.15.0`     | only for the libsql/Turso migration providers                |

The migration toolkit also shells out to [Atlas](https://atlasgo.io) and `drizzle-kit`; both are runtime requirements of `comb migrate diff`, not install-time dependencies.

## First schema

Define a table with Comb's column factories instead of Drizzle's raw ones.

```ts
/* src/db/core.tables.ts */
import { sqliteTable, index } from "drizzle-orm/sqlite-core"
import { c, patterns } from "@lovrozagar/comb/sqlite/columns"
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
export default {
	databases: {
		core: {
			dialect: "sqlite",
			driver: "d1",
			tables: "./src/db/core.tables.ts",
			output: { default: "./src/db/_gen" },
		},
	},
}
```

Generate:

```bash
bunx comb codegen core
```

## CLI

```
comb — database codegen + migration toolkit

COMMANDS:
  codegen [db] [-g gen]          Run codegen (uses comb.config.ts)
  codegen --tables <path>        Direct mode (analyze + generate)
  migrate diff <db> [name]       Schema diff -> migration SQL
  migrate apply <db> <file>      Apply migration to database
  migrate init                   Generate drizzle.config.ts + atlas.hcl

OPTIONS:
  -g, --generator <name>         Run specific generator only
  -e, --env <name>               Environment (local|dev|prod)
  --tables <path>                Tables file path (direct mode)
  --yes, -y                      Auto-confirm destructive changes
  --help                         Show this help
```

The binary requires Bun — the shebang is `#!/usr/bin/env bun`, and `comb migrate diff` invokes `bun drizzle-kit export`.

External tools the migration commands shell out to, none of them install-time dependencies:

| Command                             | Needs                                                     |
| ----------------------------------- | --------------------------------------------------------- |
| `migrate diff`                      | [Atlas](https://atlasgo.io) on `PATH`, plus `drizzle-kit` |
| `migrate apply`, `migrate baseline` | `wrangler`, authenticated against the target account      |

The D1 provider drives `wrangler d1 execute --remote` through `Bun.spawn`, so `createD1Provider()` is Bun-only. The libsql, Turso, `bun:sqlite`, Neon, and Postgres providers have no such constraint.

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

`@lovrozagar/comb/pg/columns` exports the same `c` shape backed by `drizzle-orm/pg-core` (`text`, `integer`, `serial`, `boolean`, `jsonb`, `doublePrecision`). A table file written against Comb's `c` compiles under either dialect by swapping the import.

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
patterns.COUNTRY_ALPHA2 // "/^[A-Z]{2}$/"
patterns.E164_PHONE // "/^\\+[1-9]\\d{7,14}$/"
patterns.IANA_TIMEZONE // "/^[A-Za-z_/]+$/"
patterns.LOCALE // "/^[a-z]{2}(-[A-Z]{2})?$/"
```

## Errors

### `CombError`

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

Built-in keys (`combErrorKeys`): `CHECK_CONSTRAINT_VIOLATION`, `DATABASE_IO_ERROR`, `DATABASE_READONLY`, `DATABASE_UNAVAILABLE`, `FOREIGN_KEY_VIOLATION`, `PRIMARY_KEY_VIOLATION`, `REQUIRED_FIELD_MISSING`, `STORAGE_LIMIT_REACHED`, `UNIQUE_CONSTRAINT_VIOLATION`.

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

Three handlers, one signature — `(error: unknown, constraintMaps: ConstraintMap[]) => void`. Each inspects a driver's native error, finds the matching entry, and throws a `CombError`. If nothing matches, they return and let the original error propagate.

```ts
import { d1ErrorHandler } from "@lovrozagar/comb/sqlite/d1/error-handler"
import { pgErrorHandler } from "@lovrozagar/comb/pg/error-handler"
import { handleConstraintViolation } from "@lovrozagar/comb/sqlite/constraint-handler"

try {
	await db.insert(author).values(input)
} catch (error) {
	d1ErrorHandler(error, [authorConstraints])
	throw error
}
```

- `d1ErrorHandler` — flattens D1's nested `cause` chain and additionally recognises transient D1 failures (network, storage-limit, read-only), mapping them to `service_unavailable` so a retry layer can act on them.
- `pgErrorHandler` — reads PostgreSQL `SQLSTATE` codes and pulls the column out of the error `detail`.
- `handleConstraintViolation` — the generic SQLite path, driven by message parsing; use it for libsql, Turso, and `bun:sqlite`.

## Codegen

### Config

```ts
/* comb.config.ts */
export default {
	databases: {
		core: {
			dialect: "sqlite", // "sqlite" | "postgres"
			driver: "d1", // bun-sqlite | d1 | libsql | neon | node-postgres | postgres-js | turso
			tables: "./src/db/core.tables.ts",
			filePrefix: "db.core", // generated file name prefix
			generators: ["dtos", "orm"], // omit to run all
			output: { default: "./src/db/_gen" },
			fts: {
				post_translation: { columns: ["title", "body"], tokenizer: "porter unicode61" },
			},
		},
	},
}
```

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

`diff` runs `bun drizzle-kit export` to dump the desired schema, hands it to Atlas, and writes a timestamped SQL file. `apply` then, per migration:

1. Ensures `__drizzle_migrations` exists.
2. Skips the file if its hash is already recorded.
3. Classifies it — `parseMigration()` and `classifyMigration()` split the statements and flag destructive ones. `extractDropStatements()` feeds the `confirmDrops()` prompt, which `--yes` bypasses.
4. Makes it idempotent (`makeIdempotent()` adds `IF NOT EXISTS` / `IF EXISTS` where it is safe to).
5. Creates backup tables for destructive steps, applies, verifies, and records the hash.
6. Cleans up backups on success.

Failures go through `withRetry()` and a circuit breaker (`createCircuitBreaker`, `checkCircuitBreaker`, `updateCircuitBreaker`) so a flaky D1 endpoint does not leave a migration half-applied across a batch.

### SQLite transforms

Atlas wraps SQLite table rebuilds in `PRAGMA foreign_keys = off;` … `PRAGMA foreign_keys = on;`. That pragma is a no-op inside a transaction, which is exactly where D1 runs it — so the rebuild proceeds with FK enforcement still live and fails. `applySqliteMigrationTransforms()` rewrites the pair into a single `PRAGMA defer_foreign_keys = on;` prelude, which defers enforcement to commit time and is transaction-safe. It is idempotent and leaves every `CREATE`, `ALTER`, and `INDEX` statement byte-identical.

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

Operators: `eq`, `ne`/`neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`, `ilike`, `is`, `contains`.

`validateFilter()` parses and checks in one step, against declared field types, and rejects operators a type does not support — `string` allows `like`, `boolean` allows only `eq`, `ne`, and `is`, and so on. Unknown fields are rejected rather than silently dropped, so a typo returns a 400 instead of the whole table.

```ts
import { validateFilter } from "@lovrozagar/comb/query"

const result = validateFilter("status.eq.published,or(minute_read.lt.5,title.like.intro)", {
	minute_read: "number",
	status: "enum",
	title: "string",
})

/* null when the filter string is empty */
if (result && !result.valid) {
	throw new CombError({ errorKey: result.errors[0]!, status: "bad_request" })
}
const ast = result?.ast
```

`parseFilter()` is the parse-only half, returning a `FilterAST` (or `null`) without validating field names.

### Sorting

`parseOrder()` accepts `field.asc`, `field.desc`, and null placement (`field.desc.nullslast`), producing `SortField[]`. Computed sorts use the same `@` prefix and are resolved through a `ComputedSortResolver`.

### Sparse fieldsets

`parseSelect()` implements PostgREST `select`, including relation selection:

```
select=id,title,author(display_name)
```

`createListQuerySchema({ fields })` is what puts `select` on the wire and `selectable` on `x-comb`. Without `fields`, the param is omitted. The query stays fat (sort / id / `_total` / merge keys); the response gets thin. `drizzle.paginate` and `drizzle.project` honor `parsedFields` as the last mutation of item shape. Do not apply `select=` in the HTTP framework.

`getEntityColumns()`, `buildColumns()`, `buildRelationColumns()`, `getRelationSelection()`, `hasRelation()`, `hasScalarsRequested()`, and `filterBySelect()` turn the parsed selection into what Drizzle's `columns` and `with` options expect. `filterBySelect` stays exported for odd call sites; `drizzle.project` is the one-row wrapper.

### Pagination and cursors

Two modes share one input shape. Offset pagination takes `page` and `limit`; cursor pagination takes `cursor` and `limit`. `encodeCursor()` and `decodeCursor()` round-trip an opaque cursor holding the sort key and id; `parseCursorForQuery()` turns it into a keyset predicate, and `getPrimarySortDirection()` picks the comparison direction. Responses carry `PaginationMeta`.

```ts
import { PAGINATION_DEFAULTS, createCursor, decodeCursor } from "@lovrozagar/comb/query"
```

### Zod schemas

`defineListQuery()` declares what an endpoint permits, returning `{ capabilities, schema }` — a `ListQueryCapabilities` to validate against and the Zod schema to parse the raw query string with:

```ts
import { defineListQuery } from "@lovrozagar/comb/query"

const postQuery = defineListQuery({
	filter: { created_at: "date", minute_read: "number", status: "enum", title: "string" },
	sort: ["created_at", "title"],
	search: ["title"],
	relationFilter: { "author.display_name": "string" },
	computedFilter: { popular: "boolean" },
	computedSort: ["popularity"],
	pagination: { defaultLimit: 20, maxLimit: 100 },
})

const parsed = postQuery.schema.parse(request.query)
```

Anything not listed is rejected: a field absent from `filter` cannot be filtered on, a field absent from `sort` cannot be sorted by, and `limit` is clamped to `maxLimit`. `computedFilter` and `computedSort` declare the `@`-prefixed virtual fields your resolvers will handle.

`createListQuerySchema()` and `createRetrieveQuerySchema()` are the lower-level builders, and `listQueryBaseSchema` / `paginationResponseSchema` are exported for composing your own. Every parameter ships an OpenAPI description and examples (`FILTER_DESCRIPTION`, `ORDER_EXAMPLES`, `SELECT_DESCRIPTION`, …) so a generated spec documents the grammar without you restating it.

### SQLite SQL generation

```ts
import { applyListQuery, buildListQuery, likeSearch } from "@lovrozagar/comb/query/sqlite"
import { isNull } from "drizzle-orm"

const result = buildListQuery({
	parsed, // the parsed query from defineListQuery
	table: post,
	baseWhere: isNull(post.deleted_at), // ANDed in — soft deletes, tenant scoping, access rules
	search: likeSearch(post.title),
	computedSorts: { popularity: (dir) => sql`view_count ${sql.raw(dir)}` },
})

const rows = await applyListQuery(db.select().from(post).$dynamic(), result)
```

`buildListQuery()` returns `{ where, orderBy, limit, offset, search, meta }` — it builds clauses, it does not execute. `applyListQuery()` is the convenience that chains them onto a Drizzle query; skip it if you need to interleave joins. `meta.type` tells you whether cursor or offset pagination won (cursor takes precedence), and `limit` is deliberately `parsed.limit + 1` in cursor mode so you can detect a next page.

`buildDerivedListQuery()` handles queries over a subquery or CTE, where sort columns come from a `sortColumns` map rather than the table. Underneath, `filterToSQL()`, `conditionToSQL()`, and `sortToOrderBy()` are exported for advanced use, along with `buildCursorSQL()` for keyset predicates and the JSON helpers `jsonCol()`, `jsonColAs()`, `jsonBool()`, `jsonNullable()`, and `buildScalarJsonParts()` for assembling a JSON row in SQL.

Search comes in two flavours. `likeSearch(column)` is the portable fallback — it targets a pre-normalized `_search` column, strips diacritics, lowercases, escapes LIKE specials, and ANDs each whitespace-separated term. `buildFtsMatch()`, `buildFtsWhere()`, and `buildFtsHighlight()` target the FTS5 tables the `fts` generator created, and `buildFtsWhereWithSpellfix()` adds spellfix1 fuzzy matching where the extension is available. `sanitizeFtsTerm()` escapes user input before it reaches the FTS5 query parser — always route user text through it.

### Translations

`resolveTranslation()` picks one row out of an array of translation rows: the requested `lang`, else `defaultLang`, else the first available. `fields` narrows the returned keys (`null` keeps all), and `languageCodeKey` names the discriminator column (default `languageCode`). It is pure and dependency-free, so it runs equally well over rows Drizzle already loaded via `with`.

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

```ts
import { openD1Session } from "@lovrozagar/comb/sqlite/d1/session"
import { drizzle } from "drizzle-orm/d1"

const { client, session } = openD1Session(env.DB, bookmarkFromCookie)
const db = drizzle(client, { relations, schema })
```

Reads go to the nearest replica while a bookmark guarantees the client never sees state older than its own last write. Without a bookmark it opens `first-unconstrained`. If `withSession` is missing — miniflare, older runtimes — it returns the raw handle and `session: undefined`, so the same code path works locally.

### Bookmarks

```ts
import { BookmarkTracker } from "@lovrozagar/comb/sqlite/d1/bookmark"

const tracker = new BookmarkTracker()
tracker.track(session, "core")
/* after the response body is settled */
for (const { tag, bookmark } of tracker.getBookmarks()) setCookie(tag, bookmark)
```

`getBookmarks()` skips sessions that never committed rather than throwing, so it is safe to call unconditionally at the end of a request.

### Sharding

```ts
import { ShardRouter, shardMap } from "@lovrozagar/comb/sqlite/d1/sharding"

/* module scope — the LRU must outlive the request */
const router = new ShardRouter({ totalShards: 16, maxOrgsPerShard: 500 })

export default {
	async fetch(request, env, ctx) {
		const mapping = await router.resolveOrAllocate(orgId, { coreDb: env.CORE_DB, kv: env.SHARDS }, ctx)
		// …
	},
}
```

Resolution is three tiers: a per-isolate LRU with stale-while-revalidate, then KV, then the core D1 `shard_map` table (exported as a ready-to-use Drizzle table). Allocation is fill-then-next — an org lands on the lowest-numbered shard under `maxOrgsPerShard`. Revalidation of a stale LRU entry is handed to `ctx.waitUntil()`, so it never sits in the request's critical path. `invalidate()` clears both caches after a manual remap.

Tunables: `lruMaxSize` (1000), `lruTtlMs` (5 min), `lruHardTtlMs` (15 min), `kvTtlSeconds` (60), `maxOrgsPerShard` (500). Pass `log` for a structured hook on every hit, miss, and allocation.

## Meta contract

comb stamps facts about your tables and queries onto the schemas it generates, so a document
generator downstream can publish them without re-deriving anything.

```ts
import { readCombEntityMeta } from "@lovrozagar/comb/meta"

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
import { generateId, generateUlid, LruCache } from "@lovrozagar/comb"

generateUlid() // "01jqx8r4m2n7p3q5s6t8v9w0xy" — lexicographically sortable
generateId("pst") // "pst_01jqx8r4m2n7p3q5s6t8v9w0xy"
```

ULIDs use Crockford base32 with a 10-character timestamp and 16 characters of randomness, so ids sort by creation time and index well as text primary keys. `generateId()` validates the prefix against `^[a-z][a-z0-9]{1,9}$`.

`LruCache` is the cache behind the shard router, exported on its own: bounded size, a soft TTL that marks entries stale for stale-while-revalidate (`getWithMeta()` returns `{ value, stale }`), and a hard TTL that evicts.

## Package exports

| Specifier                                    | Contents                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `@lovrozagar/comb`                           | `CombError`, `generateId`, `generateUlid`, `LruCache`, error keys and types |
| `@lovrozagar/comb/types`                     | `StatusKey`, `ConstraintMap`, `DatabaseErrorHandler`, …                     |
| `@lovrozagar/comb/cli`                       | CLI entry point                                                             |
| `@lovrozagar/comb/codegen`                   | `analyze`, `validateTables`, `parseFieldConstraints`, analysis types        |
| `@lovrozagar/comb/codegen/analyze`           | the analyzer alone                                                          |
| `@lovrozagar/comb/codegen/generators`        | every `generate*` function                                                  |
| `@lovrozagar/comb/migrate`                   | config, providers, apply, parse, Atlas helpers                              |
| `@lovrozagar/comb/migrate/drivers`           | provider factories and introspection                                        |
| `@lovrozagar/comb/query`                     | filter, order, select, cursors, Zod builders                                |
| `@lovrozagar/comb/query/sqlite`              | SQL generation, FTS5, JSON helpers                                          |
| `@lovrozagar/comb/sqlite/columns`            | `c` for SQLite                                                              |
| `@lovrozagar/comb/sqlite/constraints`        | constraint types                                                            |
| `@lovrozagar/comb/sqlite/patterns`           | shared regex patterns                                                       |
| `@lovrozagar/comb/sqlite/constraint-handler` | generic SQLite error mapping                                                |
| `@lovrozagar/comb/sqlite/d1/session`         | `openD1Session`                                                             |
| `@lovrozagar/comb/sqlite/d1/bookmark`        | `BookmarkTracker`                                                           |
| `@lovrozagar/comb/sqlite/d1/error-handler`   | `d1ErrorHandler`                                                            |
| `@lovrozagar/comb/sqlite/d1/sharding`        | `ShardRouter`, `shardMap`                                                   |
| `@lovrozagar/comb/pg/columns`                | `c` for PostgreSQL                                                          |
| `@lovrozagar/comb/pg/error-handler`          | `pgErrorHandler`                                                            |

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
│   │   ├── cli.ts
│   │   └── index.ts
│   └── tests/
│       ├── unit/           vitest
│       ├── bun/            bun:test — needs bun:sqlite
│       └── fixtures/
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

## Releases

Push a `v*` tag matching `packages/core/package.json`. The release workflow re-runs the full check set, publishes to npm with provenance via GitHub OIDC and to GitHub Packages, then opens a GitHub release with generated notes.

```bash
git tag v0.1.0
git push origin v0.1.0
```

## License

MIT © Lovro Žagar
