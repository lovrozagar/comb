---
tags: [map]
---

# Map

Cheap outline. Not a file dump.

## Protocol
- `.rulesync/reference/cascade.md` — session agent tools; grunt-job first; spawn grunt when cheaper
- `.rulesync/reference/rtk.md` — shell compression
- `.rulesync/reference/browser.md` — Lightpanda-first session CLI (`nav|snap|click|fill|scroll|wait|hover|select|shot|pdf|stop`); not MCP
- `.rulesync/reference/hooks.md` — hook policy
- `.rulesync/reference/map.md` — this file
- `.rulesync/reference/output.md` — default voice
- `.rulesync/reference/scope.md` — size gate; research → suggest → wait → `/write-plan` → `/implement-plan`
- `.rulesync/reference/law.md` — domain law (stub; protocol stays cascade/overview)
- Generated catalogs: `.rulesync/reference/INDEX.md` — aggregate catalog composed from slices (law.md, skills-map.md, refs-map.md). Maps/law = slices for deep dive. INDEX always. Not if-maps-else

## Agent SSOT
- Docs SoT: `.rulesync/skills` + `.rulesync/reference`. Generate maps anything placed there. `.agents` / `.claude` (and other host trees) are mirrors, not SoT; no mirror scan
- `.rulesync/subagents/{orchestrator,grunt}.md`
- `.rulesync/rules/overview.md` → `AGENTS.md`
- `.rulesync/rules/CLAUDE.md` → `CLAUDE.md`
- Default output: `.rulesync/reference/output.md` (overview.md → AGENTS.md; also agent bodies + CLAUDE.md, not auto-injected)

## Grok hand files
- `.grok/hooks/orchestrate-parent.js` + `.grok/hooks/orchestrate-parent.json` — spawn/fat/stop/persist / SubagentStop intercept / session receipt
- Init/upgrade prune (cumulative): retired skills `parent` `solo` `cascade`; agents `implementer` `thinker` (host files + `.grok/roles/{name}.toml` + `.gemini/agents/{name}/`); scripts `telemetry.mjs` `grunt-config.mjs`; `.grok/parent.md`; `.grok/skills/shared`; `.rulesync/grunt.config.jsonc` plus local overlay and example; reserved skill dirs this package no longer ships
- `.grok/hooks/rtk.json` — RTK
- `.grok/skills/` — generated from `.rulesync/skills/`; do not hand-edit
- `.grok/global-settings.toml` — merged into `~/.grok/config.toml` by `scripts/sync-global-settings.mjs` (not auto-loaded; project config cannot set `[features]`)
- `.rulesync/global-settings/` — host manifest and reserved noop payloads
- `.rulesync/mcp-policy.jsonc` — MCP deny-default SSOT (`default: deny`, `allow: []`)
- `.rulesync/skills/{ask,auto,browser,clasp,commit,commit-and-push,commit-push,commit-push-deploy,commit-push-release,explain,google-workspace,handoff,implement-plan,listen,pickup,speak,tmp,write-plan}/` — skill SSOT; `rulesync -f skills` emits host mirrors byte-equal

## Scripts
- `scripts/pipeline.mjs` — inner generate/check/watch chain (rulesync + emit-* + hooks-union / check-globals). Called by `guarded-roots`; not a public npm script (`rulesync:generate` `rulesync:check` `rulesync:watch` only)
- `scripts/guarded-md.mjs` — sentinel merge for `AGENTS.md` `CLAUDE.md` `GEMINI.md`; copied into consumers
- `scripts/guarded-roots.mjs` — snapshot/remerge `AGENTS.md` `CLAUDE.md` `GEMINI.md` around pipeline; check interiors wrapper
- `scripts/check-globals.mjs` — `$HOME/.grok/config.toml` `[agent].name==orchestrator` + `[features].two_pass_compaction==true`
- `scripts/gate-fat-tools.mjs`
- `scripts/scrub-spawn-prompt.mjs`
- `scripts/grunt-job.mjs` — flags `--job` `--query` `--path` `--glob` (repeatable) `--cwd`; regex in `--query` OK; never `cd &&`; unknown flags / exec shell-meta → FALLBACK
- `scripts/parse-need.mjs`
- `scripts/persist-handoff.mjs` — `.tmp/grunt/handoffs/{serial}-{slug}-{stamp}.md`
- `scripts/persist-tmp.mjs` — `.tmp/grunt/{serial}-{slug}-{stamp}.{ext}` root files
- `scripts/persist-plan.mjs`
- `scripts/persist-implementation.mjs` — `.tmp/grunt/implementations/{serial}-{slug}-{stamp}.md`
- `scripts/sync-global-settings.mjs`
- `scripts/purge-global-mcps.mjs`
- `scripts/emit-mcp-policy.mjs`
- `scripts/emit-gemini.mjs`
- `scripts/emit-agent-shell-tools.mjs`
- `scripts/browser.mjs` — session browser rail
- `scripts/google-workspace.mjs` — Sheets Docs Slides Calendar Gmail Drive
- `scripts/speak.mjs` — TTS
- `scripts/listen.mjs` — STT
- `scripts/setup.mjs` — handheld speak / listen / google-workspace / browser (`~/.grunt/`)
- `scripts/doctor.mjs` — unified prereqs; optional google-workspace (`oauth` `tokens` `adc` `clasprc`), speak, clasp, ffmpeg, whisper-cli

## Tmp
- `.tmp/grunt/plans/` — persist-plan; format SSOT = `.rulesync/reference/plan-format.md`
- `.tmp/grunt/implementations/` — persist-implementation; format SSOT = `.rulesync/reference/implementation-format.md`
- `.tmp/grunt/orchestrator-logs/` — need-intercept, session-gate, stop-block stamps
- `.tmp/grunt/` — scratch + `/tmp` dumps `{serial}-{slug}-{stamp}.{ext}` at root (not nested `tmp/`)
- `.tmp/grunt/browser/` — browser session/profile/shot/pdf (not MCP)
- `.tmp/grunt/handoffs/` — persist-handoff / `/handoff`
- `.tmp/grunt/stash/` — grunt-job / snap overflow
- `.tmp/grunt/sessions/{sid}/` — wrote/read/receipt
- `.tmp/grunt/speak/` — TTS mp3
- `.tmp/grunt/listen/` — STT wav + `latest.txt`

## Generated (do not hand-edit; committed, not gitignored)
- `AGENTS.md`, `CLAUDE.md`
- `.rulesync/reference/INDEX.md`, `skills-map.md`, `refs-map.md` (`emit-maps.mjs`)
- `.claude/skills/*`, `.agents/skills/*`, `.grok/skills/*` (from `.rulesync/skills/`)
- `.grok/agents/*`
- `.claude/agents/*`
- `.codex/agents/*`
- `.agents/agents/*`
- `.grok/config.toml` — project MCP `[[permissions]]` + `[plugins] deny_default`; no `[features]`
- `.mcp.json` — `mcpServers` from policy allow only
- `.claude/settings.json` MCP keys; Agent denies/hooks stay
- `.codex/config.toml` `mcp_servers` (absent when allow empty)
- `.agents/mcp_config.json`
- `GEMINI.md` — `@AGENTS.md` pointer (`emit-gemini.mjs`)
- `.gemini/agents/{orchestrator,grunt}/agent.md`
- `.gemini/settings.json` — `mcpServers` from policy allow only
