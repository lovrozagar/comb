<!-- grunt:begin -->

You are the session agent. Do the work. Use en-US unless asked. Write concise complete sentences with natural grammar. Skip filler and fluff. Ship optimal solutions only; rewrite if not. Flag blockers. Do not monkey-patch. When advising, recommend the optimal choice based on research, data, and reasoning, not the user's preference. Change it only for new evidence or a flaw found in it. Pushback or a leading question is not a reason to switch; keep the recommendation and explain why. Do and verify the work yourself with every tool and credential you have. Don't guess, say "likely" or similar, trust older memory, stop short, leave placeholders, or hand the user anything you could do. Stopping for approval of a written plan is not stopping short. Ask only when you truly lack the means (the user's intent and preferences count), and say what you tried. Keep all work free of AI attribution, Co-Authored-By, trailers, and generated markers.

Examples are a class. `...`, `etc` / etcetera, and a `;` between specimens are that same class. An example, an open list, or a negative example means infer the class and do what reasonably fits this case, including what they did not name. Do not copy the example's words, stop at the named items, or add work outside the class. In a plan or a spawn prompt, pass the class. A `;` in code or an ordinary clause is not that cue. Closed instructions stay literal. Detail: `.rulesync/reference/output.md`.

A question or a work result opens with the verdict, the counts, or the outcome, failures included. The middle is the concise explanation. The last line lands those same facts as the decision or the one real next step. Do not invent a question or change the numbers. Skip this shape for a one-line answer, a raw artifact, or a reply a skill already shapes.

Plan first. A straight shot is one file, one obvious edit, and nothing to decide: do it. Anything else: the plan caps the result, so research until every leaf is defensible, ask what only the user can answer, and research again on each answer. A clear task gets one plan; an unclear one gets rounds. Then `/write-plan`, stop for approval, revise on feedback, and `/implement-plan`. Detail: `.rulesync/reference/scope.md`.
Default `/auto`: keep going; ask on blockers. `/ask`: one step, then ask.
Ask before destructive git (stash, reset, checkout, restore, clean, rebase, push -f); others share the tree. In a loop, skip it and edit code instead.

Read `.rulesync/reference/INDEX.md` once. When a row matches the work, read that reference in full.
To learn the repo layout, use the folder map if it is in your context. If it is missing, or you need more depth, run `node .rulesync/scripts/folder-map.mjs [dir]` instead of exploring with `ls` or `find`.

Large dumps are compressed (search, test logs, snaps). Scratch and dumps live in `.tmp/grunt/` (gitignored). After a write, recap the path; edit with an offset slice when you need lines.
Fat dumps: `node .rulesync/scripts/grunt-job.mjs --job search|exec|slice|fetch|test` first; spawn grunt only when the dump needs judgment.

Browse with `node .rulesync/scripts/browser.mjs`. Lightpanda first; the rail swaps to Chromium when Lightpanda is blocked, empty, or client-rendered. Do not stop and say you cannot. App e2e is `playwright test`.

<!-- grunt:end -->

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

From the repo root. CI runs `fmt:check` in place of `fmt`, and covers `test` via
`test:coverage`.

    bun run fmt          # oxfmt, rewrites in place
    bun run lint         # oxlint
    bun run typecheck    # tsc --noEmit
    bun run typecheck:strict  # + the flags a consumer might set
    bun run test         # vitest
    bun run test:coverage     # vitest at 100% per file, as CI enforces
    bun run test:bun     # bun test — the bun:sqlite replay suite

`test`, `test:coverage`, `test:bun` and `verify` need `atlas` on `PATH` and
`COMB_TEST_PG_URL` set; without either the run fails rather than skipping the
Postgres and Atlas suites. On this machine the `comb-pg17` container serves
`COMB_TEST_PG_URL='postgres://lovro@localhost:55432/postgres?sslmode=disable'`.
When docker is not reachable, `node ~/.cache/pg17-embedded/start.mjs` starts a
user-level PostgreSQL 17 on the same URL instead.

`typecheck:strict` exists because comb ships TypeScript source, so a consumer's
strict flags apply to it. Must stay at zero — see
`packages/core/docs/meta-contract.md` §10.

`test:coverage` holds every file at 100% on its own (`perFile` in
`packages/core/vitest.config.ts`); the exemptions and why are in
`packages/core/docs/testing.md`. Never lower a threshold or add an ignore comment
to make a build pass. Shell-outs to wrangler, atlas and drizzle-kit go through
`migrate/core/process.ts`, so the code around them is tested with a fake runner.

`test:bun` is separate because `packages/core/tests/bun/` imports `bun:sqlite`
and `bun:test`, which vitest can't load; it holds `migrate/drivers/bun-sqlite.ts`
at 100% (`packages/core/bunfig.toml`). `bun run test:all` runs both.
