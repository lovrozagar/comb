# Testing

How comb's tests are laid out, what each gate checks, what the coverage report leaves out and why, and the lint rules, all at error.

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
    security/                      the adversarial suite, one hostile input per guard
  tests/structure/                 layout, boundary, API and README invariants (project "unit")
  tests/types/*.typetest.ts        type-level tests; `typecheck` compiles them, nothing runs them
  tests/bun/                       bun:test only: bun:sqlite and Bun.SQL parity (`bun run test:bun`)
  tests/e2e/*.e2e.test.ts          the comb binary on scratch apps (`bun run test:e2e`)
  tests/consumers/                 the packed tarball in fresh projects (`bun run test:consumers`)
```

- Every source file has `<name>.test.ts` beside it. `tests/structure/sibling-test.test.ts` enforces that; its `KNOWN_MISSING` list may only shrink.
- `index.ts`, `types.ts` and `*-types.ts` are exempt only while their AST holds imports, re-exports and type declarations alone. With runtime code they need a test like any other file. `bin.ts` is exempt because it only runs as a process.
- Fixtures live in a `__fixtures__/` directory beside the code that reads them. `package.json` `files` excludes `src/**/*.test.ts` and `src/**/__fixtures__/**`, and `tests/structure/exports.test.ts` checks the packed tarball.
- Shell-outs go through `src/migrate/core/process.ts` (`Run`); code around them is unit-tested with a fake runner. `tests/structure/process-boundary.test.ts` keeps that module the only one that starts a process.
- `tests/structure/api.test.ts` snapshots the emitted `.d.ts` closure of every export subpath under `__snapshots__/api/`. A change to an exported signature or its JSDoc fails it; rerun it with `-u` and review the snapshot diff as the API change it is.
- `tests/structure/readme.test.ts` compiles every ` ```ts ` block of the README under strict consumer flags, resolves its links and anchors, and holds the "Package exports" table to the manifest. A `<!-- ts-context … -->` comment right above a block declares the names the snippet assumes.

## Gates

`bun run verify` runs each gate in order, stops at the first failure, and stamps the commit when all pass; it refuses a dirty tree. pre-push refuses any commit without a stamp.

Every test run is in UTC, as CI's runners are: the vitest configs set `TZ` before their workers fork, and `bunfig.toml` preloads `tests/bun/support/utc.ts` for the bun suites, whatever the shell's `TZ`. A time-zone-dependent expectation then fails locally as it would in CI (`tests/structure/workflows.test.ts` holds the pins). The suites that turn a `Date` into a key or a bound run a second time in Asia/Kathmandu (UTC+05:45), as the vitest projects `unit (Asia/Kathmandu)` and `integration (Asia/Kathmandu)`, listed in `tests/support/off-utc.ts`; a value that shifts with the time zone fails there though it passes in UTC.

| Gate               | Runs                                                                                                | In CI                          |
| ------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------ |
| `fmt:check`        | oxfmt over the tree                                                                                 | `check`                        |
| `lint`             | oxlint with the comb plugin, every rule at `error`                                                  | `check`                        |
| `typecheck`        | `tsc --noEmit` over `src`, `tests` and `lint`, the type tests included                              | `check`                        |
| `test`             | vitest projects `unit` and `integration`: needs `atlas` on `PATH` and `COMB_TEST_PG_URL`            | `test`, as `test:coverage`     |
| `typecheck:strict` | `tsc -p tsconfig.strict.json` over `src` with every flag a consumer may set                         | `check`                        |
| `test:bun`         | `bun test tests/bun`, with its own coverage gate; needs `COMB_TEST_PG_URL`                          | `test`                         |
| `test:e2e`         | `vitest.e2e.config.ts`: needs `atlas` and `wrangler` on `PATH`, and `COMB_TEST_PG_URL` for Postgres | `e2e`, with a Postgres service |
| `test:consumers`   | `vitest.consumers.config.ts`: needs the npm registry                                                | `consumers`, Node 22.12 and 24 |

The e2e suites (`sqlite`, `d1`, `fts`, `postgres`) run the real binary under bun against a scratch app: `migrate diff` through real Atlas and drizzle-kit, `migrate apply` to libsql, to D1 through `wrangler --local`, and to Postgres through Atlas, `migrate status`, and `codegen`. `postgres.e2e.test.ts` makes its target and dev databases on `COMB_TEST_PG_URL` and drops them; without the URL it fails, locally as in CI. The consumer cells pack comb, install the tarball into a fresh project twice (required peers only, then every peer, each at comb's peer range), import every subpath under bun and `tsx`, bundle with Vite and wrangler, and compile every subpath with `tsc` in a `bundler` and a `nodenext` project.

## Mutation harness

A guard is load-bearing only if a test goes red without it. `tests/structure/mutation-harness.ts` registers each guard (`GUARDS`: an id, its module, what the suite must catch, and a `disable` built from the module's real exports). `tests/integration/security/guards.test.ts` reads `COMB_MUTANT`, mocks that guard's module with the guard off, and imports the code under test after the mock.

`tests/structure/mutation-harness.test.ts`, in the `test` gate, runs the security suite once with every guard in place, which must pass, and once per guard disabled, which must fail. By hand:

    bun packages/core/tests/structure/mutation-harness.ts                     # every guard; prints killed or SURVIVED
    COMB_MUTANT=raw-sql-quoting bunx vitest run tests/integration/security    # one mutant, from packages/core

A new guard gets a `GUARDS` entry and a case in the security suite in the same change; an unknown `COMB_MUTANT` throws, so a typo never runs the plain suite.

## Harnesses

| Harness                  | File                                  | Engine                                                                                                                                                |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libsqlMemory()`         | `tests/integration/support/libsql.ts` | in-process SQLite on `@libsql/client` `:memory:`, with drizzle                                                                                        |
| `d1Memory()`             | `tests/integration/support/d1.ts`     | Miniflare (workerd): D1 bound as `CORE`, KV bound as `KV`; call `dispose()`                                                                           |
| `describePg` / `usePg()` | `tests/integration/support/pg.ts`     | a real Postgres server through node-postgres and postgres.js; fresh sessions per test, TEMP tables only                                               |
| `withScratchDb(run)`     | `tests/integration/support/pg.ts`     | a whole database made for `run` on that server and dropped after it (`WITH (FORCE)`), for Atlas, which needs a clean database rather than TEMP tables |

| Variable           | Effect                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMB_TEST_PG_URL` | The Postgres server for the Postgres suites and the Bun.SQL parity case, which are required: unset, the run fails at once, locally as in CI, so a `bun run verify` stamp always covers them. Example: `postgres://lovro@127.0.0.1:5432/postgres?sslmode=disable`; Atlas reads it through lib/pq, which wants TLS unless told otherwise. |
| `COMB_MUTANT`      | The guard id the security suite disables (see [Mutation harness](#mutation-harness)). Unset or empty: every guard stays in place.                                                                                                                                                                                                       |

The Postgres migrate suites run the real Atlas against scratch databases: `atlas-classify.test.ts` classifies Atlas's own output for each kind of change in both URL scopes, `migrate-diff.test.ts` diffs, applies each result to a scratch target and diffs again (views, policies, an extension type on a persistent dev database, enums, a non-public schema, and `docker://postgres/17/dev` where `docker info` succeeds), and `migrate-apply.test.ts` applies, baselines and reports through `applyWithAtlas`, held locks and lock timeouts included.

Postgres runs on a real server rather than an emulator because the error handler reads driver error shapes (`code`, `constraint` vs `constraint_name`, Bun.SQL's `errno`), which only real drivers produce.

## Coverage

`bun run test:coverage` runs both vitest projects and reports one table over `src/**` and `lint/**`. Every file must reach 100% lines, branches, functions and statements on its own (`perFile` in `vitest.config.ts`); the patterns below are the only exemptions. No `v8`, `c8` or `istanbul` ignore comment is allowed (`comb/no-v8-ignore`).

`migrate/drivers/bun-sqlite.ts` imports `bun:sqlite`, so `bun run test:bun` measures it: `packages/core/bunfig.toml` turns coverage on for `tests/bun`, leaves out every other file those suites load (vitest measures them), and fails below 100%.

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

### Severity

Every rule above, the size rules (`complexity` 15, `max-depth` 4, `max-lines` 300 and 500 for tests, `max-lines-per-function` 60, `max-params` 3), `unicorn/consistent-function-scoping` and the `vitest` rules (`expect-expect`, `no-conditional-expect`, `no-disabled-tests`, `no-focused-tests`) are `error` over `src`, `lint` and `tests`, with no hits in the tree. A new rule starts at `warn` only while its hits are being fixed, and moves to `error` in the change that clears the last one.

On 2026-10-17, after the foundation work, the same rules had 426 hits (source / tests): complexity 28/0, max-depth 23/0, max-lines 8/0, max-lines-per-function 26/63, max-params 27/0, consistent-function-scoping 6/16, no-conditional-expect 0/113, boundaries 10/0, no-console 43/0, no-module-side-effects 36/0, no-module-state 2/0, no-silent-catch 17/0, raw-sql-allowlist 8/0.
