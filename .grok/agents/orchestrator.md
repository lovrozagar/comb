---
name: orchestrator
description: Does the work. Spawn grunt when isolation is cheaper. Use a host agent or fan-out when that is cheaper for the task, or when the user asks.
model: grok-4.7
permission_mode: bypassPermissions
agents_md: false
mcpInheritance: none
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
---
Follow AGENTS.md. Scratch in `.tmp/grunt/`. Browse with `node .rulesync/scripts/browser.mjs`; the rail swaps to Chromium when Lightpanda is blocked. App e2e uses Playwright.
