<!-- Managed by ~/Development/standards (files/md/gates.md). Edit it there, then run `bun sync.ts`. -->
# Gates

## Script contract

Every repo has these `package.json` scripts. Hooks and CI call only these names, so a tool change is one line in `~/Development/standards/standards.json`.

| script              | runs                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `fmt` / `fmt:check` | oxfmt                                                              |
| `lint` / `lint:fix` | oxlint, with the shared base config and the repo's own rule plugin |
| `typecheck`         | the repo's type check (moving to `bun check`)                      |
| `test`              | the repo's suite                                                   |

## Where each gate runs

| when       | what                                                                                                                          | blocks                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| pre-commit | `oxlint --fix`, then `oxfmt` on staged files (restaged); `oxfmt --check` and `oxlint` on them; `bun run typecheck`            | the commit            |
| commit-msg | commitlint (Conventional Commits)                                                                                             | the commit            |
| pre-push   | `fmt:check`, `lint` on the whole tree; `scripts/standards-check.ts`                                                           | the push              |
| CI         | the full gates on every push to `main`: `fmt:check`, `lint`, `typecheck`, `test` (or `test:coverage`), then `standards.gates` | new work, until fixed |

Sync writes the list CI runs, in order, to `standards.ci` in `package.json`, so a repo's own test of its workflow reads it from there.

## Push and CI

No full suite runs locally. Each commit runs the tests its change reaches: the touched test files and the tests of the code it changed. Then push, and run `bun scripts/ci-wait.ts`. It waits for CI's push run on HEAD and prints one line:

- passed, with the run's URL: done
- failed, naming the failed jobs and the path under `.tmp/grunt/ci/` that holds their logs: read the log, fix, commit, push, and run ci-wait again
- superseded, when a newer push cancelled the run: wait on that commit, as the line says
- cancelled with no newer push, or no run within the grace (the commit was never pushed): the line names the next command

Exit 0 is passed, 2 superseded, 1 everything else. A push cancels the run before it, so batch the commits and push once.

## Release

The version bump rides in the final push. Only a commit ci-wait passed on `main` gets the `v*` tag. The release workflow runs no tests: it waits for that commit's `ci.yml` push run and publishes on its success, so a bump made after the green push is a new commit and costs another CI run.

## Standards sync

`~/Development/standards` holds the shared tooling. `bun sync.ts` upgrades grunt, writes the managed files, deletes the ones it retired, installs, regenerates rulesync output and commits `chore: sync grunt <v> + standards <sha>`. It runs no gates: the commit's hooks check it, and CI runs the gates when it is pushed. A repo with uncommitted changes is skipped as pending; its next push fails `standards-check` until `bun ~/Development/standards/sync.ts --only <repo>` runs on the clean tree. `standards-check` also fails when grunt, oxfmt, oxlint or lefthook have a newer npm release than the one pinned: run `bun sync.ts --bump` in `~/Development/standards`.

## Browsers

- Chrome: `offscreen --hypr` adds a hidden virtual monitor to the running Hyprland; tests drive Chrome on it over CDP. It never takes focus. `exec` and `run` are refused in that mode.
- Safari: the MacBook Air M3 over Tailscale (`ssh mac`, `safaridriver -p 4799`), one run at a time.
