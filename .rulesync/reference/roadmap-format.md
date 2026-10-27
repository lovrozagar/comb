# Roadmap format (SSOT)

Ordered program of child plans. Not a plan, a handoff, or a design doc.

## Path

`docs/roadmaps/{serial}-{slug}-{YYYYMMDDTHHMMSSZ}.md`

- **serial:** unpadded decimal int ≥ 1. Never `0001`.
- **filename:** `^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*-\d{8}T\d{6}Z\.md$`
- Create mints the next serial. A later write of an existing file keeps that path and serial.
- Child plans stay in `.tmp/grunt/plans/`.

## Frontmatter

```yaml
---
serial: 1
name: auth-program
status: draft          # draft | locked | in-progress | done | blocked
created: 2026-10-25T18:00:00Z
source: "<≤120 chars>"
---
```

`draft` → `locked` → `in-progress` → `done` | `blocked`.

`/implement-roadmap` refuses `draft`.

## Body headings (this order only)

`# {slug}`, `## Goal`, `## Context`, `## Decisions`, `## Order`, `## Watch-outs`, `## Verify`

No other `##` headings. No Type key. No Commit key.

| Section | Amount |
|---|---|
| Goal | 1–3 sentences. Program done-when. |
| Context / Decisions / Watch-outs | bullets. Decisions: each choice plus the rejected alternative. Watch-outs may be `(none)`. |
| Order | one checkbox per slice, `N [ ] Title: {2–6 words}` |
| Verify | 1–5 runnable program gates, same `N.M [ ]` grammar as plans |

Under each slice, indented, not checkboxes:

```
1 [ ] Title: auth types
      Goal: Reserved names list the new skills.
      Why: Later slices add skills. This slot keeps init and INDEX together.
      Location: .tmp/grunt/plans/14-auth-types-20261025T165531Z.md
```

- **Goal:** one sentence. What that slice's plan ships.
- **Why:** one or two sentences. Why this slot, and what it unlocks.
- **Location:** omit in a draft. When present, the plan path `/write-plan` returns (`.tmp/grunt/plans/{file}`) or that path made absolute. A slice that already has Location does not get a second plan.
- `[x]` only after that child plan's Verify is done.

A roadmap has at least two slices. One slice is `/write-plan`.

## Validation checklist

- filename stamped and unpadded; `name` equals the slug
- `status` is one of the five values; `source` ≤120
- headings in order; no extra `##`
- Goal 1–3 sentences; Context, Decisions, Watch-outs are bullets
- ≥2 slices; each has Title (2–6 words), one-sentence Goal, and Why (1–2 sentences)
- Location, when present, is `.tmp/grunt/plans/{file}` or absolute
- Verify has 1–5 leaves
- a fresh create is `draft` and has no `[x]`
