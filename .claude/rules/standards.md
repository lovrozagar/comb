---
paths:
  - '**/*'
---
<!-- Managed by ~/Development/standards (files/md/standards.rule.md). Edit it there, then run `bun sync.ts`. -->

## Tests are the truth

Every change starts with a test: a bug, a reported issue, a review finding, a feature, a refactor. Red: write the test and run it to show it fails. Fix: the smallest change that makes it pass. Green: run it again, then the tests the change reaches. A fix without a test that failed first is not done. Detail: `.rulesync/reference/tdd.md`.

## Every gate passes before moving on

Locally, a commit runs the tests its change reaches: the touched test files and the tests of the code it changed. Never the full suites; those are CI's.

CI on the pushed tip is the full gate. After a push, `bun scripts/ci-wait.ts` waits for the run and names any failed job and its log. While CI is red, the only work is fixing it. For comb, CI runs `fmt:check`, `lint`, `typecheck`, `test:coverage`, then:
- `typecheck:strict`
- `test:bun`
- `test:e2e`
- `test:consumers`

Hooks enforce the fast checks. pre-commit fixes, formats and lints the staged files and type-checks. pre-push checks fmt and lint over the whole tree and checks the repo is in sync with `~/Development/standards`. Never use `--no-verify`. A failure is never skipped, retried away, or called flaky. Detail: `.rulesync/reference/gates.md`.

## Managed files

Files with a "Managed by ~/Development/standards" header, `*.base.*` configs, `.oxfmtrc.jsonc`, and the `scripts`, `devDependencies` and `standards` keys sync sets in `package.json` come from `~/Development/standards`. Edit them there and run `bun sync.ts --only comb`; an edit here fails pre-push. `lefthook.yml`, `.oxlintrc.json` and `lint/` belong to this repo.
