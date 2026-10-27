---
root: false
targets: ["*"]
description: "Gates, red-green TDD and the standards sync for comb"
globs: ["**/*"]
---
<!-- Managed by ~/Development/standards (files/md/standards.rule.md). Edit it there, then run `bun sync.ts`. -->

## Tests are the truth

Every change starts with a test: a bug, a reported issue, a review finding, a feature, a refactor. Red: write the test and run it to show it fails. Fix: the smallest change that makes it pass. Green: run it again, then every gate. A fix without a test that failed first is not done. Detail: `.rulesync/reference/tdd.md`.

## Every gate passes before moving on

`bun run verify` runs every gate in order, stops at the first failure, and stamps the commit when all pass. For comb: `fmt:check`, `lint`, `typecheck`, `test:coverage`, then:
- `typecheck:strict`
- `test:bun`
- `test:e2e`
- `test:consumers`

Hooks enforce it. pre-commit fixes, formats and lints the staged files and type-checks. pre-push checks fmt and lint over the whole tree, checks the repo is in sync with `~/Development/standards`, and refuses a push whose tip has no verify stamp; the commits under the tip ride on its verify. Never use `--no-verify`, never stamp by hand. CI runs the same scripts on every push to `main`. While any gate is red, locally or in CI, the only work is fixing it. A failure is never skipped, retried away, or called flaky. Detail: `.rulesync/reference/gates.md`.

## Managed files

Files with a "Managed by ~/Development/standards" header, `*.base.*` configs, `.oxfmtrc.jsonc`, and the `scripts`, `devDependencies` and `standards` keys sync sets in `package.json` come from `~/Development/standards`. Edit them there and run `bun sync.ts --only comb`; an edit here fails pre-push. `lefthook.yml`, `.oxlintrc.json` and `lint/` belong to this repo.
