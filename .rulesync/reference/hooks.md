---
tags: [hooks]
---

# Hooks

SessionStart carries only the folder map: Claude / Codex run `../../.rulesync/scripts/session-map.mjs`, which injects the code-only map from `../../.rulesync/scripts/folder-map.mjs` as `additionalContext` (capped under Claude Code's 10,000-char per-hook `additionalContext` limit, about 2.4k tokens, below the 5k `grunt map` budget; cache-stable, fail-open) and logs `{rows, tokens}` to `.tmp/grunt/sessions/<sid>/map.json`. Inject nothing else at SessionStart. Antigravity has no rulesync sessionStart. Do not register a SessionStart hook on `../../.grok/hooks/orchestrate-parent.json`.

Grok PostToolUse / SessionStart are observe-only — do not attempt output scrub; compress via RTK / spawn / isolation facts only. Do not add PostToolUse scrub hooks. UserPromptSubmit may emit a one-line `sessionGate=auto|ask` plus session receipt, then up to 8 other live lines from `~/.grunt/board/` (`hookSpecificOutput.additionalContext`). The current session's own line is omitted. Skip host Stop banners. `/ask` exact-match slash stamps `session-gate-{sid}` to `ask`. `/auto` unlinks. Sid-less: no stamp. Default: `auto`.

In `sessionGate=ask`, parent Stop on `end_turn` blocks unless the recap asks (`?`) or is exactly `[orchestrator]: wait grunt`. Reason: `ask after this step`. Cap 3. `sessionGate=auto` does not Stop-block.

Claude / Codex / Antigravity PreToolUse still run `../../.rulesync/scripts/scrub-spawn-prompt.mjs` and `../../.rulesync/scripts/gate-fat-tools.mjs`, and Gemini's `BeforeTool` runs `../../.rulesync/scripts/gate-fat-tools.mjs`. Grok spawn/fat rewrite is `../../.grok/hooks/orchestrate-parent.js`. RTK stays `../../.grok/hooks/rtk.json`.
Claude Code's `WorktreeCreate` and `WorktreeRemove` come from the `claudecode` block of `hooks.jsonc` and run `../../.rulesync/scripts/worktree.mjs hook` (60s), so its worktrees land in `.worktrees/<name>` on `wt/<name>`. Other harnesses have no such event and call `worktree.mjs add` directly.

Session agent tools are on. Fat Read/Grep/Glob/Bash still gate. Writes under `.tmp/grunt/plans/`, `.tmp/grunt/handoffs/`, `.tmp/grunt/implementations/`, `.tmp/grunt/roadmaps/`, and `.tmp/grunt/` root files persist via `../../.rulesync/scripts/persist-plan.mjs` / `persist-handoff.mjs` / `persist-implementation.mjs` / `persist-tmp.mjs` / `persist-roadmap.mjs`. The hook hands the host the absolute path of the saved file. Invalid body denies. A Write of a saved plan updates that file in place (same serial); an Edit of a saved plan is checked against the text it would produce, and a valid one runs as sent. `## Previous mistakes` entries are append-only on both. Roadmaps follow the same rules: a Write of a saved roadmap is validated and the host writes it, and an Edit is checked against the text it would produce.

Writes under `.rulesync/lessons/` go through `../../.rulesync/scripts/lessons.mjs`: a lesson Write is validated, saved, and reindexed (`INDEX.md`); an Edit of a lesson is denied with the Write and `lessons.mjs hit` routes. On any other Write or Edit, PreToolUse adds `additionalContext` for lessons whose globs match the file, each once per session (`.tmp/grunt/sessions/<sid>/lessons-seen.json`). It reads only `INDEX.md` and fails open.

SubagentStop (and child Stop with `subagentType`) intercepts a parseable `need:` whose jobs are all `search|exec|slice|fetch` (cap 4): runs grunt-job in-hook and continues the child with concatenated facts. Mixed/web/test, parse fail, FALLBACK, `stopHookActive`, or more than 3 intercepts per child session → empty stdout (allow stop).

Stop and SubagentStop timeout is 30s (grunt-job cap is 20s). PreToolUse / UserPromptSubmit stay at 5s.

rulesync canonical event is `beforeSubmitPrompt` (→ Claude/Codex `UserPromptSubmit`), not `userPromptSubmit`.

`[features] two_pass_compaction` must live in `~/.grok/config.toml` (from `.grok/global-settings.toml` via `npm run sync:globals` / `npm run sync:globals:apply`). Project `.grok/config.toml` cannot set `[features]`.
