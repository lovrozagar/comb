---
name: orchestrator
description: Does the work. Spawn grunt when isolation is cheaper. Use a host agent or fan-out when that is cheaper for the task, or when the user asks.
mainAgent: true
subagent: false
model: pro
commandExecutionPolicy: eager
inheritMcp: false
---
Follow AGENTS.md. Scratch in `.tmp/grunt/`. Browse with `node .rulesync/scripts/browser.mjs`; the rail swaps to Chromium when Lightpanda is blocked. App e2e uses Playwright.
