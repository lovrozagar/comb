<!-- Managed by ~/Development/standards (files/md/gates.md). Edit it there, then run `bun sync.ts`. -->
# Gates

## Script contract

Every repo has these `package.json` scripts. Hooks, `verify` and CI call only these names, so a tool change is one line in `~/Development/standards/standards.json`.

| script              | runs                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `fmt` / `fmt:check` | oxfmt                                                                                                         |
| `lint` / `lint:fix` | oxlint, with the shared base config and the repo's own rule plugin                                            |
| `typecheck`         | the repo's type check (moving to `bun check`)                                                                 |
| `test`              | the repo's suite                                                                                              |
| `verify`            | `fmt:check`, `lint`, `typecheck`, `test`, then `standards.gates` from package.json; stamps HEAD when all pass |

## Where each gate runs

| when       | what                                                                                                                            | blocks                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| pre-commit | `oxlint --fix`, then `oxfmt` on staged files (restaged); `oxfmt --check` and `oxlint` on them; `bun run typecheck`              | the commit            |
| commit-msg | commitlint (Conventional Commits)                                                                                               | the commit            |
| pre-push   | `fmt:check`, `lint` on the whole tree; `scripts/standards-check.ts`; `scripts/pre-push.ts` (each pushed tip has a verify stamp) | the push              |
| CI         | the same scripts on every push to `main`                                                                                        | new work, until fixed |

## verify and the stamp

`bun run verify` refuses a dirty tree, runs every gate, and on success writes `standards-verified/<sha>` in the common git dir. Worktrees share it, so a commit verified in a worktree pushes from the main checkout. Nothing commits the stamp. Push and CI are the full gate: only the pushed tip needs a stamp, and the commits under it ride on its verify, so a stack of commits costs one verify, not one each.

## Standards sync

`~/Development/standards` holds the shared tooling. `bun sync.ts` upgrades grunt, writes the managed files, installs, regenerates rulesync output, commits `chore: sync grunt <v> + standards <sha>`, and runs `verify`. A repo with uncommitted changes is skipped as pending; its next push fails `standards-check` until `bun ~/Development/standards/sync.ts --only <repo>` runs on the clean tree. `standards-check` also fails when grunt, oxfmt, oxlint or lefthook have a newer npm release than the one pinned: run `bun sync.ts --bump` in `~/Development/standards`.

## Browsers

- Chrome: `offscreen --hypr` adds a hidden virtual monitor to the running Hyprland; tests drive Chrome on it over CDP. It never takes focus. `exec` and `run` are refused in that mode.
- Safari: the MacBook Air M3 over Tailscale (`ssh mac`, `safaridriver -p 4799`), one run at a time.
