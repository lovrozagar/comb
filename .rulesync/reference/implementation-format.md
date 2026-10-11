# Implementation format (SSOT)

Local session journal for `/implement-plan`. Not a plan, handoff, or git commit.

Created when `/implement-plan` starts. Straight shots skip this file. Do not merge into the plan (plan = flip the box only).

## Path

`.tmp/grunt/implementations/{serial}-{slug}-{YYYYMMDDTHHMMSSZ}.md`

- **serial:** own counter (not plan serials). Unpadded decimal int ≥ 1. Never `0001`.
- **filename:** unpadded serial, slug, UTC datetime stamp. Same regex as new plans: `^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*-\d{8}T\d{6}Z\.md$`
- **lookup:** integer equality on leading digits.
- Frontmatter `serial:` line must match `^serial: [1-9][0-9]*$`.
- New writes always stamped. Collision: increment serial, same stamp.

## Link

Frontmatter `plan:` is the plan serial (`6`) or `none`. Own serial stays independent.

## Slugify / allocate

Same as plans (`slugify`, `nextSerial` on this dir). Body line 1: `IMPL_NAME: <3-6 word name>`. Optional `IMPL_PLAN: <n|none>` (default `none`).

## Frontmatter (required)

```yaml
---
serial: 1
plan: 6                 # unpadded int or none
name: add-auth
status: in-progress     # in-progress | done | blocked
created: 2026-08-26T14:30:00Z
source: "<≤120 chars of user task>"
---
```

### Status machine

`in-progress` → `done` | `blocked`

- Fresh write: `in-progress`
- Plan Verify done and journal caught up: `done`
- Cannot finish: `blocked` (`## Blockers` must not be `(none)`)

## Body headings (this order only)

`# {slug}`, `## Done`, `## Issue`, `## Files`, `## Log`, `## Blockers`, `## Notes`

No other `##` headings.

| Section | Amount |
|---|---|
| Done | bullets. What landed and why. Past tense. Fresh: `(none)` |
| Issue | bug root cause bullets, or `(none)` |
| Files | repo-relative product paths as `- path` bullets. Default `/commit` stage set. No abs paths. No `.tmp/`. Fresh: `(none)` |
| Log | append-only. Fresh: `(none)`. After each plan leaf: `N.M [x] one line` (notes, fail, skip). `[x]` allowed |
| Blockers | open problems. `(none)` unless `status: blocked` |
| Notes | short leftovers, or `(none)` |

## Write

Write under `.tmp/grunt/implementations/` (any filename in that dir). Grok `orchestrate-parent.js` runs `scripts/persist-implementation.mjs` on create (`IMPL_NAME:`): serial/slug from the name, injects frontmatter, rewrites path + content. Updates to an existing file keep the path; full-body writes are validated in place. Invalid create/update denies — fix the body, do not retry elsewhere.

Host without that hook: name the file per **Path**, or pipe the body to `node scripts/persist-implementation.mjs --workspace {repo}` and use its `path`.

Never allocate a new serial to log a leaf. Append Log, update Files/Done, flip the plan box.

## Validation checklist

- filename stamped unpadded; serial int equals leading digits; `name` equals slug
- frontmatter keys: `serial`, `plan`, `name`, `status`, `created`, `source`
- `plan` is `none` or unpadded int ≥ 1; `status` ∈ `in-progress` | `done` | `blocked`
- headings in order only; no extra `##`
- Done / Issue / Files / Log / Blockers / Notes: bullets and/or `(none)`; none of those sections empty
- Files: repo-relative; reject abs and `.tmp/`
- `status: blocked` ⇒ Blockers is not only `(none)`

## Worked example

File: `.tmp/grunt/implementations/1-add-tmp-ignore-20260826T143000Z.md`

```markdown
---
serial: 1
plan: 6
name: add-tmp-ignore
status: in-progress
created: 2026-08-26T14:30:00Z
source: "gitignore .tmp so local plans stay untracked"
---

# add-tmp-ignore

## Done
- Repo `.gitignore` ignores `.tmp/` so plans stay untracked

## Issue
(none)

## Files
- .gitignore

## Log
1.1 [x] read existing gitignore
1.2 [x] appended .tmp/

## Blockers
(none)

## Notes
(none)
```
