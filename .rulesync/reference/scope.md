---
tags: [scope]
---

# Scope

Default: do the work. Escalate only when it is not a straight shot. This file is the size-gate SSOT.

## Gate

Straight shot: one obvious path, the user named the edit, or a follow-up on work already agreed. Do it. Do not run this file as a ritual.

Not a straight shot: ambiguous goal, two or more valid approaches, cross-cutting, or hard to undo — or the user asked to plan.

Skip the loop: questions, lookups, one-file named edits, "just do it", commits.

`/ask` is not this loop. `/ask` pauses after each execution step. This loop pauses until the approach is agreed. `/auto` already treats a real choice as a blocker; "which approach?" is that blocker.

## Research

Read and search until you can pick an approach. Enough to choose, not a literature review. Fat notes go under `.tmp/grunt/` (`/tmp` if they must persist). Do not add `## Research` to a plan.

## Suggest

5–10 lines: approach, why, rejected alternative, one open question. Not a fake plan. Do not `/write-plan` in the same turn.

## Wait

Stop. One real question. Feedback → research if needed → suggest again. Repeat until the approach is agreed.

## Plan

After agreement only: `/write-plan`. Format: `.rulesync/reference/plan-format.md`. Distill facts into Context, Constraints, Watch-outs. Leaves are the work. Report serial. Stop unless the user said plan and do it.

## Implement

`/implement-plan` in a separate turn, or the same turn only if the user said plan and do it. Skip `[x]`. Write-allowlist = paths listed in the plan. Do not skip test leaves. Journal: `.rulesync/reference/implementation-format.md` under `.tmp/grunt/implementations/` (create on start; not for straight shots). Straight-shot behavior change: run the nearest existing test if the repo has one. Bugfix: repro first. Do not scaffold a test file on a straight shot unless it is a bug.
