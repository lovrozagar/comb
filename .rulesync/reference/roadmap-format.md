# Roadmap format (SSOT)

Ordered program of child plans. Not a plan, a handoff, or a design doc.

## Path

`.tmp/grunt/roadmaps/{serial}-{slug}-{YYYYMMDDTHHMMSSZ}.md`

- **serial:** unpadded decimal int ≥ 1. Never `0001`.
- **filename:** `^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*-\d{8}T\d{6}Z\.md$`
- Create mints the next serial. A later write of an existing file keeps that path and serial. The hook validates the update and the host writes it. An Edit of a saved roadmap is checked against the text it would produce, and a valid one runs as sent.
- Child plans stay in `.tmp/grunt/plans/`.

## Frontmatter

```yaml
---
serial: 1
name: auth-program
status: draft          # draft | locked | in-progress | done | blocked
reviews: 0             # settled /review-roadmap rounds; never lowered or removed
created: 2026-10-25T18:00:00Z
source: "<≤120 chars>"
---
```

`draft` → `locked` → `in-progress` → `done` | `blocked`.

`/implement-roadmap` refuses `draft`.

`reviews` counts the `/review-roadmap` rounds whose findings the writer settled. It starts at `0`, never goes down, and once present cannot be removed. A body-only save sends it as a bare `reviews: {n}` line above `ROADMAP_NAME:`, and a save that omits it keeps the saved count. Moving into `locked` needs `reviews` ≥ 1; a missing key counts as 0. A roadmap already past `draft` without the key stays editable.

## Body headings (this order only)

`# {slug}`, `## Goal`, `## Usage`, `## Context`, `## Decisions`, `## Order`, `## Watch-outs`, `## Verify`, `## Previous mistakes`

No other `##` headings. No Type key. No Commit key. A roadmap saved before `## Usage` or `## Previous mistakes` existed stays valid without them; a fresh save needs both. Lines inside a code fence are never headings.

| Section | Amount |
|---|---|
| Goal | 1–3 sentences. Program done-when. |
| Usage | What a person or agent types and sees once the whole program lands: each new or changed command, flag, output, error message, or file, in fenced blocks, with the before for each changed one; or one line: `No visible change:` and why. |
| Context / Decisions / Watch-outs | bullets. Decisions: each choice plus the rejected alternative. Watch-outs may be `(none)`. |
| Order | one checkbox per slice, `N [ ] Title: {2–6 words}` |
| Verify | 1–5 runnable program gates, same `N.M [ ]` grammar as plans |
| Previous mistakes | `(none)`, or one entry per line. Append-only |

Under each slice, indented, not checkboxes:

```
1 [ ] Title: auth types
      Goal: Reserved names list the new skills.
      Why: Later slices add skills. This slot keeps init and INDEX together.
      Location: .tmp/grunt/plans/14-auth-types-20261025T165531Z.md
```

- **Goal:** one sentence. What that slice's plan ships.
- **Why:** one or two sentences. Why this slot, and what it unlocks.
- **Location:** omit in a draft. When present, the absolute plan path `/write-plan` reported. A slice that already has Location does not get a second plan.
- `[x]` only after that child plan's Verify is done.

A roadmap has at least two slices. One slice is `/write-plan`.

## Previous mistakes

Mistakes about the program: slice order, slice boundaries, a Decision that turned out wrong, a premise later slices lean on. A mistake inside one slice stays in that child plan.

```
- {feedback|verify|review|premise|slice}: {what was wrong} → {what changed}
```

- `feedback`, `review`, and `premise` mean what they mean in a plan. `verify` is a failed program Verify gate.
- `slice` is roadmap-only: what child plan N found that changed a Decision, the Order, or a later slice. The same save makes that change.
- Optional ` (lesson: {slug})` at the end when the entry is also a lesson.
- `/implement-roadmap` copies each entry that touches a slice into that slice's plan Watch-outs, and promotes entries that outlive the program to lessons before `done`.

## Validation checklist

- filename stamped and unpadded; `name` equals the slug
- `status` is one of the five values; `source` ≤120
- headings in order; no extra `##`
- Goal 1–3 sentences; Context, Decisions, Watch-outs are bullets
- ≥2 slices; each has Title (2–6 words), one-sentence Goal, and Why (1–2 sentences)
- Location, when present, is the absolute plan path (a relative `.tmp/grunt/plans/{file}` in an older roadmap still resolves)
- Verify has 1–5 leaves
- `## Previous mistakes` is last, required on a fresh create, and keeps every saved entry unchanged and in order
- `reviews` is a whole number, never lower than the saved one; `locked` needs at least 1
- a fresh create is `draft`, `reviews: 0`, and has no `[x]`
