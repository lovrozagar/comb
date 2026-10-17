# Testing

How comb's tests are laid out, what each gate checks, and the lint baseline the size rules start from.

## Lint

One `oxlint` run from the repo root reads `.oxlintrc.json`. Its override for `packages/core/{src,lint}/**` and `packages/core/tests/{integration,structure}/**` adds the `vitest` plugin, the size rules and the `comb` plugin in `packages/core/lint/`.

| Rule                          | Enforces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comb/boundaries`             | Runtime code (`query`, `sqlite`, `pg`, `meta`, shared roots) never value-imports tooling (`codegen`, `migrate`, `cli`, `bin`); `pg ↮ sqlite`, `migrate ↮ query`; shared roots (`error`, `types`, `lru`, `id`, `states`) import only each other; type-only imports are exempt from those arrows; imports stay inside `src`; packages (type-only included) are dependencies or peers; builtins carry `node:`; the `Bun` global and `bun:` modules stay in `migrate/core/process.ts`, `migrate/drivers/bun-sqlite.ts` and `bin.ts` |
| `comb/no-console`             | `console` only in `src/log.ts` and `src/cli/output.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `comb/no-module-side-effects` | Module scope runs no code unless the call is marked `/* @__PURE__ */` (`sideEffects: false` is a promise)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `comb/no-module-state`        | Module-scope `let`, `var` or `const x = new …` carries `// lookup-table: …`, `// lru-cache: …` or `// per-process-constant: …`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `comb/no-silent-catch`        | Every `catch` rethrows, returns or throws the converted error, calls a reporter, or says `// reason: …`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `comb/no-v8-ignore`           | No `v8`, `c8` or `istanbul` ignore hints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `comb/raw-sql-allowlist`      | `sql.raw` only in `query/sqlite/{search,keyset,filter-sql}.ts`, with a string literal, a ternary of literals or `quoteIdent(…)`                                                                                                                                                                                                                                                                                                                                                                                                 |

Each rule has a test beside it that runs the rule in process (`reportsOf`) and through the real oxlint binary (`oxlintReports`), both from `lint/rule-harness.ts`. The harness writes fixtures to `os.tmpdir()` and refuses a tmpdir inside a git checkout, because oxlint applies that checkout's `.gitignore` and would lint nothing.

### Baseline

A rule with hits in the tree is `warn` until the hits are gone, then `error`. Counts on 2026-10-17, when the plugin landed:

| Rule                                                            | Hits | Severity |
| --------------------------------------------------------------- | ---: | -------- |
| `complexity` (15)                                               |   28 | warn     |
| `max-depth` (4)                                                 |   23 | warn     |
| `max-lines` (300, 500 for tests)                                |    9 | warn     |
| `max-lines-per-function` (60)                                   |   26 | warn     |
| `max-params` (3)                                                |   27 | warn     |
| `unicorn/consistent-function-scoping`                           |    6 | warn     |
| `comb/boundaries`                                               |   16 | warn     |
| `comb/no-console`                                               |   76 | warn     |
| `comb/no-module-side-effects`                                   |   37 | warn     |
| `comb/no-module-state`                                          |    2 | warn     |
| `comb/no-silent-catch`                                          |   20 | warn     |
| `comb/raw-sql-allowlist`                                        |    8 | warn     |
| `comb/no-v8-ignore`                                             |    0 | error    |
| `vitest/no-conditional-expect`                                  |    0 | warn     |
| `vitest/expect-expect`, `no-disabled-tests`, `no-focused-tests` |    0 | error    |
