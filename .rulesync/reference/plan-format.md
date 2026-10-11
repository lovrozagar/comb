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
created: 2026-08-26T14:30:00Z    # UTC ISO-8601 seconds + Z; no milliseconds
source: "<≤120 chars of user task>"
---
```

`name` is the slug only (no datetime). `source` ≤120 chars.

`created` for **new writes:** `new Date().toISOString()` with milliseconds stripped (`.\d{3}Z` → `Z`), e.g. `2026-08-26T14:30:00Z`. Existing files may still have `created: YYYY-MM-DD`.

### Status machine

`ready` → `in-progress` → `done` | `blocked`

- Fresh write: `ready`
- Implement start: `in-progress`
- All boxes `[x]`: `done`
- Cannot finish: `blocked` (leave remaining `[ ]`)

## Body headings (this order only)

`# {slug}`, `## Goal`, `## Context`, `## Constraints`, `## Watch-outs`, `## Steps`, `## Verify`

No other `##` headings. No PR Plan, Key Decisions, or DAG.
No required Why heading. Optional why footnote only (not a `##`). Pick2 file plan stays how-first; missing Why heading does not block.

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
| Context / Constraints / Watch-outs | bullets only. Watch-outs: non-obvious footguns; empty allowed (`(none)`). |
| Steps | bulk of the file; each leaf = one coherent edit or one file-level action |
| Verify | 1–5 runnable leaves (cmd or observable) |

Tests live in Steps (not a new heading). New behavior or a bug: a failing test leaf before the impl leaf. Other behavior change: a test leaf immediately after the impl leaf. Docs, rename-only, config-only, generated: no test leaf. Verify is the end gate (project cmd or named subset), not a substitute for those leaves. Do not re-run the whole suite after every leaf unless it is cheap.

Thinker cites **absolute paths**. Leaves must be implementable without re-planning. Product fork → pick the narrowest default, state it under Constraints, still emit steps.

## Validation checklist

- filename matches new stamped regex or legacy unstamped; new writes unpadded + stamp (`1-foo-20260826T143000Z.md` not `0001-foo.md`); serial int equals leading digits; `name` equals slug after stripping optional trailing `-\d{8}T\d{6}Z`
- frontmatter `serial` line matches `^serial: [1-9][0-9]*$` (unpadded decimal ≥ 1; reject `0001`, `"0001"`, `0`, `01`)
- frontmatter keys: `serial`, `name`, `status`, `created`, `source`
- `status` ∈ `ready` | `in-progress` | `done` | `blocked`; `created` `YYYY-MM-DDTHH:MM:SSZ` (new writes) or legacy `YYYY-MM-DD`; `source` ≤120
- headings in order only; no extra `##`; no required Why heading (optional footnote only)
- ≥1 `N.M [ ]` leaf; every phase has ≥1 leaf; Verify is last numbered phase
- checkbox grammar (`N [ ]` / `N.M [ ]` / `N.M.K [ ]`); no `- [ ]`; no `1. [ ]`
- fresh write: zero `[x]` / `[X]`; Goal 1–3 sentences; Context/Constraints/Watch-outs bullets; Verify 1–5 leaves

## Worked example

File: `.tmp/grunt/plans/1-add-tmp-ignore-20260826T143000Z.md`

```markdown
---
serial: 1
name: add-tmp-ignore
status: ready
created: 2026-08-26T14:30:00Z
source: "gitignore .tmp so local plans stay untracked"
---

# add-tmp-ignore

## Goal
Repo `.gitignore` ignores `.tmp/` so files under `.tmp/grunt/plans/` stay untracked. Existing ignore entries stay.

## Context
- `/home/ecomet/Development/example-app/.gitignore` may be missing or lack `.tmp/`
- Plans live at `/home/ecomet/Development/example-app/.tmp/grunt/plans/`
- No python helpers; bash only

## Constraints
- Do not clobber other `.gitignore` lines
- Do not create sample plans under `.tmp/grunt/plans` for git
- Do not edit `AGENTS.md`

## Watch-outs
- Duplicate `.tmp/` if append without grep
- Use directory form `.tmp/`, not `.tmp`

## Steps
1 [ ] gitignore
1.1 [ ] read `/home/ecomet/Development/example-app/.gitignore` if it exists
1.2 [ ] create `/home/ecomet/Development/example-app/.gitignore` when missing, body `.tmp/`
1.3 [ ] append `.tmp/` to `/home/ecomet/Development/example-app/.gitignore` if the line is absent
2 [ ] plans dir
2.1 [ ] mkdir -p `/home/ecomet/Development/example-app/.tmp/grunt/plans`
2.2 [ ] confirm the dir exists; do not add a sample `*.md` under it
3 [ ] sanity
3.1 [ ] grep `^\.tmp/` in `/home/ecomet/Development/example-app/.gitignore`
3.2 [ ] confirm no extra hunks in that file besides the ignore line
3.3 [ ] `git check-ignore -v /home/ecomet/Development/example-app/.tmp/grunt/plans` from repo root

## Verify
4 [ ] Verify
4.1 [ ] `git check-ignore -v .tmp/grunt/plans` reports ignored
4.2 [ ] `git status --short -- .gitignore` shows only the ignore edit
```
