---
name: implement-plan
description: 'Execute remaining leaves in a .tmp/grunt/plans checklist. Skip [x].'
---
# implement-plan

You execute the plan in this session. Skip `[x]`. Start at the first open leaf. Flip only the box after each leaf. When a phase's children are `[x]`, mark the phase `[x]`. Frontmatter `in-progress` then `done`.

Arg `{n|path}` picks that file. Empty arg: unique in-progress, else unique ready, else list serials.

Format: `.rulesync/reference/plan-format.md`. Write-allowlist = paths listed in the plan. Run Verify leaves. Do not skip a test leaf. Do not flip a behavior leaf `[x]` until its test ran. Fat dumps go through `node scripts/grunt-job.mjs`.

On start: if this plan has no journal, Write one under `.tmp/grunt/implementations/` (`IMPL_NAME:`, `IMPL_PLAN: {n}`). Format: `.rulesync/reference/implementation-format.md`. After each leaf: append `N.M [x] …` to Log, update Files (repo-relative product paths) and Done. Blocked → `status: blocked` and Blockers. Verify done → `status: done`. Straight shots do not write a journal.
