---
name: write-plan
description: 'Write a local checklist under .tmp/grunt/plans/. Then /implement-plan {n}.'
---
# write-plan

You author the plan. Persist under `.tmp/grunt/plans/` via Write (hook runs `.rulesync/scripts/persist-plan.mjs`). Format: `.rulesync/reference/plan-format.md`.

Empty task → ask for a task and stop.

Body starts with `PLAN_NAME: <3-6 word name>`, then Goal, Context, Constraints, Watch-outs, Steps, Verify. All boxes `[ ]`. Tests: new behavior or bug → failing test leaf before impl; other behavior → test leaf right after impl; docs/rename/config/generated → skip. Verify is the end gate.

The plan is the proposal and caps the result (`.rulesync/reference/scope.md`). Before writing, research until every leaf is defensible; ask any plan-shaping question the user alone can answer, then research again on the answer. Do not default a plan-shaping choice. A minor open choice goes under Constraints as the chosen default plus "confirm".

Report: serial N at `.tmp/grunt/plans/{file}`, the goal, the phase list, the top risks, and any assumption to confirm. Do not dump the plan. Stop and ask for approval; on feedback, revise this file and stop again. Run `/implement-plan {n}` in the same turn only when the request said "plan and do it".
