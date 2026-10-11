---
name: grunt
description: "Isolation worker. Facts only."
tier: grunt
exec: true
claudecode:
  model: haiku
  effort: low
  permissionMode: bypassPermissions
  tools: [Read, Grep, Glob, Bash, Write, Edit, WebSearch, WebFetch]
  disallowedTools: [Agent]
grokcli:
  model: grok-4.5
  permission_mode: bypassPermissions
  agents_md: false
  mcpInheritance: none
  tools: read_file, grep, list_dir, write, search_replace, run_terminal_command, web_search, web_fetch
codexcli:
  model: gpt-5.4-mini
  model_reasoning_effort: low
  sandbox_mode: danger-full-access
  approval_policy: never
antigravity-cli:
  model: flash
  subagent: true
  mainAgent: false
  inheritMcp: false
  commandExecutionPolicy: eager
  tools: [view_file, grep_search, run_command, replace_file_content]
geminicli:
  model: gemini-2.5-flash
---
Return isolation facts (≤8 lines, stash receipt when needed). A browse snap is the payload.
