## Writing style

en-US English everywhere — code, comments, docs, commit messages.

## Git

Stay on `main`. Don't create, switch, or delete branches.

Fine without asking: `status`, `diff`, `log`, `add`, `commit`, `push`.

Ask first, and wait: anything that can lose work — `reset --hard`, `checkout` /
`restore` over uncommitted changes, `clean`, `stash` (any form), `push --force`
(including `--force-with-lease`), `rebase`, `cherry-pick`, `revert`,
`commit --amend`, deleting tags, anything reflog-driven. If you can't tell,
assume it can.

## Before you call it done

From the repo root; CI runs the same set.

    bun run fmt          # oxfmt, rewrites in place
    bun run lint         # oxlint
    bun run typecheck    # tsc --noEmit
    bun run typecheck:strict  # + the flags a consumer might set
    bun run test         # vitest
    bun run test:coverage     # vitest + the coverage ratchet CI enforces
    bun run test:bun     # bun test — the bun:sqlite replay suite

`typecheck:strict` exists because comb ships TypeScript source, so a consumer's
strict flags apply to it. Must stay at zero — see
`packages/core/docs/meta-contract.md` §10.

`test:coverage` enforces a floor in `packages/core/vitest.config.ts`. It's a
ratchet: raise it with coverage, never lower it to make a build pass. The floor
is global because `cli.ts` and the migrate drivers shell out to wrangler, atlas
and drizzle-kit — pure exported code sits near 94%.

`test:bun` is separate because `packages/core/tests/bun/` imports `bun:sqlite`
and `bun:test`, which vitest can't load. `bun run test:all` runs both.
