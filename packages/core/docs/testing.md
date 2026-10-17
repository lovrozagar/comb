# Testing

How comb's tests are laid out, what each gate checks, what the coverage report leaves out and why, and the lint baseline the size rules start from.

## Layout

```
packages/core/
  lint/                            the comb oxlint plugin; each rule beside <rule>.test.ts
  src/**/<name>.ts                 source
  src/**/<name>.test.ts            its unit test (vitest project "unit")
  src/**/<name>.<aspect>.test.ts   a further unit file for one aspect, e.g. id.prefix, utils.retry
  src/**/__fixtures__/             inputs a unit test reads (never shipped)
  tests/integration/               vitest project "integration", 60 s timeouts, real engines
    support/                       the harnesses below
    sqlite/ libsql/ d1/ postgres/ meta/
  tests/structure/                 layout and boundary invariants (project "unit")
  tests/bun/                       bun:test only: bun:sqlite and Bun.SQL parity (`bun run test:bun`)
```

- Every source file has `<name>.test.ts` beside it. `tests/structure/sibling-test.test.ts` enforces that; its `KNOWN_MISSING` list may only shrink.
- `index.ts`, `types.ts` and `*-types.ts` are exempt only while their AST holds imports, re-exports and type declarations alone. With runtime code they need a test like any other file. `bin.ts` is exempt because it only runs as a process.
- Fixtures live in a `__fixtures__/` directory beside the code that reads them. `package.json` `files` excludes `src/**/*.test.ts` and `src/**/__fixtures__/**`, and `tests/structure/exports.test.ts` checks the packed tarball.
- Shell-outs go through `src/migrate/core/process.ts` (`Run`); code around them is unit-tested with a fake runner. `tests/structure/process-boundary.test.ts` keeps that module the only one that starts a process.

## Harnesses

| Harness                  | File                                  | Engine                                                                                                  |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `libsqlMemory()`         | `tests/integration/support/libsql.ts` | in-process SQLite on `@libsql/client` `:memory:`, with drizzle                                          |
| `d1Memory()`             | `tests/integration/support/d1.ts`     | Miniflare (workerd): D1 bound as `CORE`, KV bound as `KV`; call `dispose()`                             |
| `describePg` / `usePg()` | `tests/integration/support/pg.ts`     | a real Postgres server through node-postgres and postgres.js; fresh sessions per test, TEMP tables only |

| Variable           | Effect                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMB_TEST_PG_URL` | The Postgres server for the Postgres suites and the Bun.SQL parity case. Unset locally: those suites skip and the run prints why. Unset with `CI` set: the run fails, because CI requires them. Example: `postgres://lovro@127.0.0.1:5432/postgres`. |

Postgres runs on a real server rather than an emulator because the error handler reads driver error shapes (`code`, `constraint` vs `constraint_name`, Bun.SQL's `errno`), which only real drivers produce.

## Coverage

`bun run test:coverage` runs both vitest projects and reports one table over `src/**` and `lint/**`. The thresholds in `vitest.config.ts` are a ratchet: raise them with coverage, never lower them.

Left out of the report, and why:

| Pattern                              | Why                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `**/*.test.ts`, `**/__fixtures__/**` | tests and their inputs are not the code under test                                                          |
| `**/index.ts`                        | barrels hold re-exports only; `sibling-test.test.ts` fails if one gains runtime code                        |
| `src/bin.ts`                         | the three-line shim over `runCli` runs only as a process, which v8 does not see; `runCli` itself is covered |

## Lint

One `oxlint` run from the repo root reads `.oxlintrc.json`. Its override for `packages/core/{src,lint}/**` and `packages/core/tests/{integration,structure}/**` adds the `vitest` plugin, the size rules and the `comb` plugin in `packages/core/lint/`.

| Rule                          | Enforces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comb/boundaries`             | Runtime code (`query`, `sqlite`, `pg`, `meta`, shared roots) never value-imports tooling (`codegen`, `migrate`, `cli`, `bin`); `pg ↮ sqlite`, `migrate ↮ query`; shared roots (`error`, `types`, `lru`, `id`, `states`) import only each other; type-only imports are exempt from those arrows; imports stay inside `src`; packages (type-only included) are dependencies or peers; builtins carry `node:`; the `Bun` global and `bun:` modules stay in `migrate/core/process.ts`, `migrate/drivers/bun-sqlite.ts` and `bin.ts` |
| `comb/no-console`             | `console` only in `src/log.ts`, `src/cli/output.ts` and `src/bin.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `comb/no-module-side-effects` | Module scope runs no code unless the call is marked `/* @__PURE__ */` (`sideEffects: false` is a promise); `bin.ts` exists to run and is exempt                                                                                                                                                                                                                                                                                                                                                                                 |
| `comb/no-module-state`        | Module-scope `let`, `var` or `const x = new …` carries `// lookup-table: …`, `// lru-cache: …` or `// per-process-constant: …`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `comb/no-silent-catch`        | Every path through a `catch` rethrows, returns or throws the converted error, or calls a reporter; otherwise it says `// reason: …`                                                                                                                                                                                                                                                                                                                                                                                             |
| `comb/no-v8-ignore`           | No `v8`, `c8` or `istanbul` ignore hints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `comb/raw-sql-allowlist`      | `sql.raw` only in `query/sqlite/{search,keyset,filter-sql}.ts`, with a string literal, a ternary of literals or `quoteIdent(…)`                                                                                                                                                                                                                                                                                                                                                                                                 |

Each rule has a test beside it that runs the rule in process (`reportsOf`) and through the real oxlint binary (`oxlintReports`), both from `lint/rule-harness.ts`. The harness writes fixtures to `os.tmpdir()` and refuses a tmpdir inside a git checkout, because oxlint applies that checkout's `.gitignore` and would lint nothing.

### Baseline

A rule with hits in the tree is `warn` until the hits are gone, then `error`. Counts on 2026-10-17, after the foundation work (source files / test files):

| Rule                                                            | Source | Tests | Severity |
| --------------------------------------------------------------- | -----: | ----: | -------- |
| `complexity` (15)                                               |     28 |     0 | warn     |
| `max-depth` (4)                                                 |     23 |     0 | warn     |
| `max-lines` (300, 500 for tests)                                |      8 |     0 | warn     |
| `max-lines-per-function` (60)                                   |     26 |    63 | warn     |
| `max-params` (3)                                                |     27 |     0 | warn     |
| `unicorn/consistent-function-scoping`                           |      6 |    16 | warn     |
| `vitest/no-conditional-expect`                                  |      0 |   113 | warn     |
| `comb/boundaries`                                               |     10 |     0 | warn     |
| `comb/no-console`                                               |     43 |     0 | warn     |
| `comb/no-module-side-effects`                                   |     36 |     0 | warn     |
| `comb/no-module-state`                                          |      2 |     0 | warn     |
| `comb/no-silent-catch`                                          |     17 |     0 | warn     |
| `comb/raw-sql-allowlist`                                        |      8 |     0 | warn     |
| `comb/no-v8-ignore`                                             |      0 |     0 | error    |
| `vitest/expect-expect`, `no-disabled-tests`, `no-focused-tests` |      0 |     0 | error    |
