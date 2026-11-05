# Plan format (SSOT)

Local session checklist. Not a design doc, PR stack, or DAG.

## Path

`.tmp/grunt/plans/{serial}-{slug}-{YYYYMMDDTHHMMSSZ}.md`

- **serial:** unpadded decimal int only (`1`, `12`, `10000`). **Never** `0001`, never quoted `"0001"` / `"1"`. Serial ≥ 1.
- **filename:** unpadded serial, slug, UTC datetime stamp (`6-sync-global-settings-20260826T143000Z.md`, not `0001-slug.md`). Stamp is `created` with `-` and `:` dropped (keep `T` and `Z`).
- **lookup:** integer equality on leading digits (`1` matches `1-foo-20260826T143000Z.md` and legacy `1-foo.md`; also `0001-foo.md` if an old padded file still exists).
- **valid filename (new):** `^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*-\d{8}T\d{6}Z\.md$`
- **valid filename (legacy):** `^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*\.md$` (no stamp; still accepted for existing files)
- Frontmatter line must match `^serial: [1-9][0-9]*$`. Leading zeros are invalid (YAML octal / VS Code warning).
- **New writes** always use the stamped filename. Collision: increment serial, rebuild filename, same stamp.

## Slugify (`PLAN_NAME`)

1. lower
2. non `[a-z0-9]` → `-`
3. collapse `-`, strip edges
4. trim to 50 chars; if cut on `-`, strip trailing `-`
5. empty → `unnamed`
6. strip trailing `.lock` if any

## Allocate next serial (grunt, bash)

```bash
mkdir -p .tmp/grunt/plans
next=1
for f in .tmp/grunt/plans/*; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  case "$b" in
    [0-9]*.md) n=${b%%-*}; n=$((10#$n)); [ "$n" -ge "$next" ] && next=$((n+1));;
  esac
done
# filename prefix: unpadded decimal "$next" (1, 12, 10000)
```

Collision: if target path exists, increment and retry (max 5).

## Frontmatter (required)

```yaml
---
serial: 1
name: add-auth
status: ready          # ready | in-progress | done | blocked
reviews: 0             # settled /review-plan rounds; never lowered or removed
created: 2026-08-26T14:30:00Z    # UTC ISO-8601 seconds + Z; no milliseconds
source: "<≤120 chars of user task>"
---
```

`name` is the slug only (no datetime). `source` ≤120 chars.

`reviews` counts the `/review-plan` rounds whose findings the writer settled: a whole number with no sign or leading zero, `0` on a new plan. The writer bumps it in the same save that applies a round's findings, even a round with no findings. It never goes down, and once present it cannot be removed, so every Write that sends full frontmatter carries the current `reviews`. The count proves a round ran and was settled, not that the review was good.

`created` for **new writes:** `new Date().toISOString()` with milliseconds stripped (`.\d{3}Z` → `Z`), e.g. `2026-08-26T14:30:00Z`. Existing files may still have `created: YYYY-MM-DD`.

### Status machine

`ready` → `in-progress` → `done` | `blocked`

- Fresh write: `ready`
- Implement start: `in-progress`, only with `reviews` ≥ 1. The save denies the move with `reviews: 0`, and a missing `reviews` counts as 0. A plan already `in-progress` without the key stays editable
- All boxes `[x]`: `done`
- Cannot finish: `blocked` (leave remaining `[ ]`)

## Body headings (this order only)

`# {slug}`, `## Goal`, `## Usage`, `## Context`, `## Constraints`, `## Watch-outs`, `## Steps`, `## Verify`, `## Previous mistakes`

No other `##` headings. A plan saved before `## Usage` or `## Previous mistakes` existed stays valid without them; a fresh save needs both. Lines inside a code fence are never headings or checkboxes. No PR Plan, Key Decisions, or DAG.
No required Why heading. Optional why footnote only (not a `##`). Pick2 file plan stays how-first; missing Why heading does not block.

## Previous mistakes

This plan's own log of what went wrong. Last heading, after Verify, no checkboxes. A new plan writes `(none)`.

- Entry: `- {source}: {what was wrong} → {what changed}`, optionally ending ` (lesson: {slug})`.
- `source`: `feedback` (the user sent the plan back), `verify` (a Verify or test failed after a fix), `review` (an accepted `/review-plan` finding), `premise` (an assumption turned out wrong).
- Append-only. A save that edits or drops an existing entry is denied and names the entry.
- An entry that will happen again on other tasks also becomes a lesson: `.rulesync/reference/lessons.md`.

## Revisions

A Write of a saved plan updates that file: same path, serial, and `created`. The given `status` and `[x]` boxes are kept. A body without frontmatter keeps the saved frontmatter. An Edit of a saved plan is checked against the text it would produce and runs as sent when valid. Never save a revision as a new plan.

## Checkbox grammar

- Open: `[ ]` (space in box required)
- Done: `[x]` (accept `[X]`, write `[x]`)
- Line: `^{id} [ ] {text}$` with optional 0–2 space indent
- `{id}` = `N` / `N.M` / `N.M.K` (digits + dots). **Not** `1. [ ]`. **Not** GitHub `- [ ]`
- Fresh plans: all `[ ]`, never `[x]`
- Marking done: only flip the box. No renumber, delete, or rewrite leaf text
- Depth 2 default (`N` phase + `N.M` leaf). 3rd level only if a leaf would itself be a mini-plan
- Every phase `N` has ≥1 leaf `N.M`. The session agent **executes leaves**. Roll up: all children `[x]` ⇒ parent `[x]`
- Verify = last numbered phase, same grammar
- Done plan: every checkbox `[x]`, `status: done`

## Prose vs steps

| Section | Amount |
|---|---|
| Goal | 1–3 sentences. What “done” means. |
| Usage | What a person or agent types and sees once the plan lands: each new or changed command, flag, output, error message, or file, in fenced blocks, with the before for each changed one. Internal steps nobody types or reads need none. A plan with no visible change writes one line: `No visible change:` and why. |
| Context / Constraints / Watch-outs | bullets only. Watch-outs: non-obvious footguns; empty allowed (`(none)`). A new plan that names a file a lesson matches cites that lesson path in Watch-outs, or the save is denied. Context includes `Task type:`, `Named checks:` from `.rulesync/reference/scope.md` ## Types, and a skip-with-reason when a named check is dropped. |
| Steps | bulk of the file; each leaf = one coherent edit or one file-level action |
| Verify | 1–5 runnable leaves (cmd or observable) |

Tests live in Steps (not a new heading). New behavior or a bug: a failing test leaf before the impl leaf. Other behavior change: a test leaf immediately after the impl leaf. Docs, rename-only, config-only, generated: no test leaf. Verify is the end gate (project cmd or named subset), not a substitute for those leaves. Do not re-run the whole suite after every leaf unless it is cheap.

Thinker cites **absolute paths**. Leaves must be implementable without re-planning. Product fork → pick the narrowest default, state it under Constraints, still emit steps.

## Validation checklist

- filename matches new stamped regex or legacy unstamped; new writes unpadded + stamp (`1-foo-20260826T143000Z.md` not `0001-foo.md`); serial int equals leading digits; `name` equals slug after stripping optional trailing `-\d{8}T\d{6}Z`
- frontmatter `serial` line matches `^serial: [1-9][0-9]*$` (unpadded decimal ≥ 1; reject `0001`, `"0001"`, `0`, `01`)
- frontmatter keys: `serial`, `name`, `status`, `reviews`, `created`, `source`. `reviews` matches `^(0|[1-9][0-9]*)$`, is `0` on a fresh write, is not lowered or removed on an update, and is ≥ 1 for a change into `in-progress`; a legacy plan without it stays valid. Optional `commit:` is a Conventional Commits subject (`type(scope): subject`, scope optional, imperative lowercase, no trailing period). A new plan includes it. A plan with no `commit` key stays valid. A present `commit` that is not that subject is invalid
- `status` ∈ `ready` | `in-progress` | `done` | `blocked`; `created` `YYYY-MM-DDTHH:MM:SSZ` (new writes) or legacy `YYYY-MM-DD`; `source` ≤120
- headings in order only; no extra `##`; `## Usage` right after `## Goal`, required on a fresh write and optional on an update to a plan saved without it, holding a fenced block or a `No visible change:` line; lines inside code fences are never headings or checkboxes; `## Previous mistakes` last and required on a fresh write, entries valid and append-only on an update; fresh write cites every matched lesson in Watch-outs; no required Why heading (optional footnote only)
- ≥1 `N.M [ ]` leaf; every phase has ≥1 leaf; Verify is last numbered phase
- checkbox grammar (`N [ ]` / `N.M [ ]` / `N.M.K [ ]`); no `- [ ]`; no `1. [ ]`
- fresh write: zero `[x]` / `[X]`; Goal 1–3 sentences; Context/Constraints/Watch-outs bullets; Context includes `Task type:`, `Named checks:`, and a skip-with-reason when a named check is dropped; frontmatter includes `commit:`; Verify 1–5 leaves

## Worked example

File: `.tmp/grunt/plans/1-notes-export-json-20260826T143000Z.md`

````markdown
---
serial: 1
name: notes-export-json
status: ready
reviews: 0
created: 2026-08-26T14:30:00Z
source: "add --json to notes export"
commit: feat(notes): add --json to notes export
---

# notes-export-json

## Goal
`notes export --json` prints every note as one JSON array on stdout, so scripts read notes without parsing the text table. The text table stays the default.

## Usage
Before:

```console
$ notes export --json
error: unknown flag --json
```

After:

```console
$ notes export --json
[{"id":1,"title":"groceries","updated":"2026-08-26T14:00:00Z"}]
$ notes export
1  groceries  2026-08-26 14:00
```

## Context
- Task type: feature
- Named checks: failing test before impl; read `principle-test-behavior-not-implementation`
- `/home/ecomet/Development/example-app/src/cli.ts` parses flags; `/home/ecomet/Development/example-app/src/export.ts` prints the table
- Rejected: a separate `notes json` command, which splits one export into two

## Constraints
- Keys are `id`, `title`, `updated`, in that order; `updated` is ISO 8601 UTC
- No new dependency

## Watch-outs
- An empty notebook prints `[]`, not nothing

## Steps
1 [ ] Read principles
1.1 [ ] read `principle-test-behavior-not-implementation`
2 [ ] Failing test
2.1 [ ] in `/home/ecomet/Development/example-app/src/export.test.ts`, `notes export --json` on two notes prints a two-element array with those keys, and on none prints `[]`
2.2 [ ] run `npm test -- export`; the new cases fail on the unknown flag
3 [ ] Implement
3.1 [ ] parse `--json` in `/home/ecomet/Development/example-app/src/cli.ts`
3.2 [ ] in `/home/ecomet/Development/example-app/src/export.ts`, print `JSON.stringify` of the notes when `--json` is set
3.3 [ ] run the test from 2.2; all pass

## Verify
4 [ ] Verify
4.1 [ ] read `principle-prove-it-works`
4.2 [ ] `npm test` passes
4.3 [ ] `notes export --json | node -e "JSON.parse(require('fs').readFileSync(0, 'utf8'))"` exits 0

## Previous mistakes
(none)
````
