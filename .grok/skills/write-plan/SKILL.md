---
name: write-plan
description: 'Write a local checklist under .tmp/grunt/plans/. Then /implement-plan {n}.'
---
# write-plan

You author the plan. Persist under `.tmp/grunt/plans/` via Write (hook runs `scripts/persist-plan.mjs`). Format: `.rulesync/reference/plan-format.md`.

Empty task → ask for a task and stop.

Body starts with `PLAN_NAME: <3-6 word name>`, then Goal, Context, Constraints, Watch-outs, Steps, Verify. All boxes `[ ]`. Tests: new behavior or bug → failing test leaf before impl; other behavior → test leaf right after impl; docs/rename/config/generated → skip. Verify is the end gate.

Report: wrote serial N at `.tmp/grunt/plans/{file}`. Next `/implement-plan {n}`. Do not dump the plan.
