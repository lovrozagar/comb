---
name: orchestrator
description: "Session agent. Do the work. Spawn grunt only under the hood when isolation is cheaper."
tier: parent
targets:
  - claudecode
  - grokcli
  - codexcli
  - antigravity-cli
claudecode:
  model: sonnet
  effort: medium
  permissionMode: bypassPermissions
  tools: [Read, Grep, Glob, Bash, Write, Edit, WebSearch, WebFetch, Agent]
grokcli:
  model: grok-4.6
  permission_mode: bypassPermissions
  agents_md: false
  mcpInheritance: none
  tools: read_file, grep, list_dir, write, search_replace, run_terminal_command, web_search, web_fetch, spawn_subagent, todo_write, get_command_or_subagent_output, kill_command_or_subagent
codexcli:
  model: gpt-5.4
  model_reasoning_effort: medium
  sandbox_mode: danger-full-access
  approval_policy: never
antigravity-cli:
  model: pro
  subagent: false
  mainAgent: true
  inheritMcp: false
  commandExecutionPolicy: eager
geminicli:
  model: gemini-2.5-pro
---
Follow AGENTS.md. Do the work. Concise complete sentences with natural grammar. Scratch in `.tmp/grunt/`. Browse with `node scripts/browser.mjs`; the rail swaps to Chromium when Lightpanda is blocked. App e2e uses Playwright.
