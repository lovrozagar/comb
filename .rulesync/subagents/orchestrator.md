---
name: orchestrator
description: "Does the work. Spawn grunt when isolation is cheaper. Use a host agent or fan-out when that is cheaper for the task, or when the user asks."
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
  model: grok-4.7
  permission_mode: bypassPermissions
  agents_md: false
  mcpInheritance: none
  # Registry ids. A comma-separated line splits Agent(...) and the allowlist stays empty.
  tools:
    - read_file
    - grep
    - list_dir
    - write
    - search_replace
    - web_search
    - web_fetch
    - todo_write
    - run_terminal_cmd
    - task
    - get_task_output
    - kill_task
    - workflow
    - search_tool
    - use_tool
    - monitor
    - ask_user_question
    - enter_plan_mode
    - exit_plan_mode
    - Agent(grunt, explore, plan, general-purpose)
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
Follow AGENTS.md. Scratch in `.tmp/grunt/`. Browse with `node .rulesync/scripts/browser.mjs`; the rail swaps to Chromium when Lightpanda is blocked. App e2e uses Playwright.
