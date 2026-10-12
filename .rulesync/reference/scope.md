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

Feedback revises the same plan file; research again if needed. Stop again until the user approves. Approval is the user saying go, or an explicit "plan and do it" in the request.

## Implement

`/implement-plan` after approval, in the same turn only on an explicit "plan and do it". Skip `[x]`. Write-allowlist = paths listed in the plan. Do not skip test leaves. Journal: `.rulesync/reference/implementation-format.md` under `.tmp/grunt/implementations/` (create on start; not for straight shots). Straight-shot behavior change: run the nearest existing test if the repo has one. Bugfix: repro first. Do not scaffold a test file on a straight shot unless it is a bug.

## Suggest

5–10 lines: approach, why, rejected alternative, one open question. Not a fake plan. Do not `/write-plan` in the same turn.

## Wait

Stop. One real question. Feedback → research if needed → suggest again. Repeat until the approach is agreed.
