---
tags: [scope]
---

# Scope

Plan by default. A straight shot is the exception. The plan caps the result, so its depth scales with the work. This file is the size-gate SSOT.

## Gate

Straight shot: one file, one obvious edit, nothing to decide. Do it. Also skip planning for questions, lookups, commits, a follow-up inside an approved plan, and an explicit "just do it".

Plan: two or more files, two or more items in the message, two or more valid approaches, cross-cutting or hard-to-undo work, or the user asked to plan. A named goal is not a named edit.

`/ask` is not this loop. `/ask` pauses after each execution step. This loop pauses on questions and on the plan. `/auto` continues after approval; it does not skip approval.

## Research

Read and search until every leaf is defensible and needs no re-planning. Depth scales with stakes and ambiguity: a clear task needs enough to write the leaves; an unclear, cross-cutting, or hard-to-undo one needs the alternatives checked against the code, docs, and data. Fat notes go under `.tmp/grunt/`.

## Questions

Ask only what research cannot settle and what changes the plan's shape: intent, scope, a trade-off the user owns. Batch them into one round, each with your recommendation. Research again on each answer, and ask again only if a new plan-shaping gap appears. When research settles everything, skip this step and write the plan in one shot.

## Plan

`/write-plan`. Format: `.rulesync/reference/plan-format.md`. The plan is the proposal: the chosen approach and its rejected alternative sit in Context or Constraints. A minor open choice is written as the default plus "confirm"; a plan-shaping one goes back to Questions. Report the goal, phases, top risks, open assumptions, and path, then stop for approval.

## Approval

Feedback revises the same plan file; research again if needed. Stop again until the user approves. Approval is the user saying go, an explicit "plan and do it" in the request, or `/implement-roadmap` running a roadmap whose status is `locked` or `in-progress`. A plan-shaping question still stops and leaves that roadmap `locked` or `in-progress`.

## Implement

`/implement-plan` after approval. Same turn when the request said "plan and do it", or when `/implement-roadmap` is running a `locked` or `in-progress` roadmap. Skip `[x]`. Write-allowlist = paths listed in the plan. Do not skip test leaves. Journal: `.rulesync/reference/implementation-format.md` under `.tmp/grunt/implementations/` (create on start; not for straight shots). Straight shot: run the nearest existing test when the repo has one, repro a bug before the edit, and scaffold a test file only for a bug. Before you call a straight shot done, read `principle-prove-it-works`. Before you ask the user, read `principle-never-block-on-the-human`. Before a large dump or a fan-out, read `principle-guard-the-context-window`.

## Types

One type per plan. Pick the strongest match. A feature that crosses an ownership, package, or API boundary is `cross-cut`. Straight shots skip this table and follow the straight-shot rule in ## Implement. Skip a named check only with a reason in Context. Approval of the plan is the select.

`/write-plan` copies the row into Steps or Verify, including a Read leaf for each named principle. `/implement-plan` reads that skill and follows it.

A slice is one child plan, not a phase. Two or more ordered slices are a roadmap (`/write-roadmap`, then `/implement-roadmap`), not one plan. Format: `.rulesync/reference/roadmap-format.md`.

| type | checks |
| --- | --- |
| bug | repro; failing test before impl; read `principle-fix-root-causes`; read `principle-test-behavior-not-implementation` |
| feature | failing test before impl; read `principle-test-behavior-not-implementation` |
| docs | no test leaf; no browser unless the doc is a live page; Verify reads the page or runs the generator |
| perf | Verify states the measurement and what limits it; read `principle-explain-the-number` |
| refactor | existing suite or characterization tests; no feature leaves; read `principle-laziness-protocol`; read `principle-subtract-before-you-add`; read `principle-minimize-reader-load`; read `principle-test-behavior-not-implementation` |
| cross-cut | Context holds architect lite (types, signatures, module map, rejected shape); a `/blast-radius` leaf; read `principle-foundational-thinking`; read `principle-type-system-discipline` |
| chore | no test leaf unless a check already exists |

## Facts

`/write-plan` adds a Read leaf for each fact that is true. No fact, no leaf. `/implement-plan` reads that skill and follows it.

| fact | read |
| --- | --- |
| a guard, parser, or adapter at a CLI, config, or network edge | `principle-boundary-discipline` |
| a new internal API while old callers still exist | `principle-migrate-callers-then-delete-legacy-apis` |
| a command or loop that must survive crash and retry | `principle-make-operations-idempotent` |
| two actors can write the same file, branch, or key | `principle-separate-before-serializing-shared-state` |
| stateful logic, or the same shape copied across files | `principle-model-the-domain` |
| a sweep of similar edits | `principle-build-the-lever` |
| a rewrite with phase boundaries | `principle-outcome-oriented-execution` |
| a person will see the output, the error text, or the default | `principle-experience-first` |
| the requirement does not fit without a special-case branch | `principle-redesign-from-first-principles` |
| research left two or more live options and the choice is hard to undo | `principle-exhaust-the-design-space` |

`/implement-plan` reads a principle only when the type row names it, a true fact names it, the next sentence names it, or an already-read principle cites it. Do not open the rest of the catalog.

Verify of every plan reads `principle-prove-it-works`. After two fixes that share a premise fail the same gate, read `principle-attack-the-premise` before a third try. Before you ask the user, read `principle-never-block-on-the-human`. Before a large dump or a fan-out, read `principle-guard-the-context-window`.

`/write-roadmap` reads `principle-sequence-verifiable-units`. `/correct` reads `principle-encode-lessons-in-structure`.

## Suggest

5–10 lines: approach, why, rejected alternative, one open question. Not a fake plan. Do not `/write-plan` in the same turn.

## Wait

Stop. One real question. Feedback → research if needed → suggest again. Repeat until the approach is agreed.
