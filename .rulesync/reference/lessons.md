---
tags: [lessons]
---

# Lessons

Mistakes that outlive one task. One committed file per mistake under `.rulesync/lessons/`, with a generated index. Not host memory: everything is in the repo and reaches every machine through git.

## Two layers

- **Plan:** `## Previous mistakes` in each plan holds that task's details: rejected approaches, failed Verify, accepted review findings. It stays with the plan in `.tmp/`. Format: `.rulesync/reference/plan-format.md`.
- **Repo:** a lesson holds a mistake that will happen again on other tasks. A plan entry that generalizes becomes a lesson, and the entry ends with `(lesson: {slug})`.

## File

`.rulesync/lessons/{slug}.md`, at most 60 lines.

```markdown
---
name: plan-forks
paths: [".rulesync/scripts/persist-plan.mjs", ".grok/hooks/**"]
hits: 1
last-hit: 2026-11-01
evidence: ["plan 16"]
---

# Plan rewrites fork serials

Rewriting a saved plan minted a new serial.

## Mistake
What went wrong, concretely.

## Fix
What to do instead.
```

- `name` is the filename slug. `paths` are repo-relative globs (`**` spans dirs; `*` and `?` stay in one segment) and each must match a file that exists.
- `hits` counts occurrences. `evidence` keeps the 5 most recent plan serials or commits.
- A new lesson may leave out `hits` and `last-hit`; the save fills `1` and today.

## Index

`.rulesync/lessons/INDEX.md` is generated: one row per lesson with path, globs, hits, last hit, and summary, sorted by hits. Do not edit it. Every lesson save, `hit`, and `rm` rewrites it, and `emit-maps.mjs` rewrites it on generate. `emit-maps.mjs --check` fails on index drift, an invalid lesson, or a glob that matches no file.

## Write

- Write the whole file. The hook validates it, renders the standard form, and reindexes; the host saves it. An Edit of a lesson is denied.
- `node .rulesync/scripts/lessons.mjs hit <slug> --evidence <text>` counts a repeat. The same evidence counts once.
- `node .rulesync/scripts/lessons.mjs rm <slug>` deletes a lesson and reindexes.
- `node .rulesync/scripts/lessons.mjs index` rebuilds the index. `check` runs the checks.

## When to write

After any of these, add a `## Previous mistakes` entry to the plan. If the mistake will happen again on other tasks, run `lessons.mjs match` on the files involved first, then `hit` the matching lesson or write a new one.

- Plan feedback from the user (`/write-plan`).
- A failed Verify, or a test that failed after a fix (`/implement-plan`).
- `principle-attack-the-premise` firing (`/implement-plan`).
- An accepted `/review-plan` finding (`/write-plan`).
- An operator correction (`/correct`).

At `hits: 2` the mistake is a class. `/correct` encodes it as a check (architecture, type, lint, or test), then runs `lessons.mjs rm`.

## When to read

- `node .rulesync/scripts/lessons.mjs match <file...>` prints the lessons whose globs match, most hits first, 10 at most.
- A new plan that names a matched file must cite that lesson's path in Watch-outs, or the save is denied with the lesson listed.
- The first time a session edits a matched file, the hook adds that lesson's summary and path to the context. Each lesson is shown once per session.
- `/review-plan` reads the matched lessons and flags one that no leaf acts on.
